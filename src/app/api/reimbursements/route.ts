import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Receipt } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import {
  extractReceipts,
  type ReceiptExtraction,
  type ExtractionEvent,
  type ExtractionEventHandler,
} from "@/lib/ai/extract";
import { isQuotaErrorMessage } from "@/lib/ai/throttle";
import { rpmTarget } from "@/lib/config";
import { composeDescription } from "@/lib/ai/compose";
import { parseDollarsToCents } from "@/lib/money";

export const runtime = "nodejs";
// Per-receipt AI extraction on a large claim can take a while — especially
// when quota errors trigger ~60s cooldown-and-retry cycles (AI_QUOTA_*).
export const maxDuration = 900;

export async function GET() {
  return handleApi(async () => {
    const userId = await requireUserId();
    const reimbursements = await prisma.reimbursement.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { lineItems: true, receipts: true } } },
    });
    return NextResponse.json({ reimbursements });
  });
}

const CreateSchema = z.object({ receiptIds: z.array(z.string().min(1)).min(1) });

function extractionLogRow(userId: string, outcome: ReceiptExtraction, reimbursementId?: string) {
  return {
    userId,
    reimbursementId,
    model: outcome.meta.model,
    prompt: outcome.meta.prompt,
    receiptsJson: outcome.meta.receiptsJson,
    rawResponse: outcome.meta.rawResponse,
    parsedJson: outcome.result ? JSON.stringify(outcome.result) : null,
    status: outcome.error ? "error" : "success",
    errorMessage: outcome.error,
    durationMs: outcome.meta.durationMs,
  };
}

/** Resolve + own-check the selected receipts, or throw the right ApiError. */
async function loadSelectedReceipts(req: NextRequest, userId: string): Promise<Receipt[]> {
  const body = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) throw new ApiError(400, "receiptIds (non-empty array) required");
  const receiptIds = [...new Set(body.data.receiptIds)];

  const receipts = await prisma.receipt.findMany({ where: { id: { in: receiptIds }, userId } });
  if (receipts.length !== receiptIds.length) {
    throw new ApiError(404, "One or more receipts were not found");
  }
  // A receipt may go on any number of claims (e.g. one purchase split across
  // two filings) — processed receipts are deliberately allowed. Each claim
  // re-extracts, overwriting the receipt's extraction metadata.
  return receipts;
}

/**
 * Run each receipt through the LLM (one call per receipt, throttled to the RPM
 * target with quota-error retries) and create the draft claim. All-or-nothing:
 * if any receipt fails to extract, no claim is created — but every call is
 * still telemetry-logged. onEvent forwards live extraction progress (per-receipt
 * completion and quota waits) so the caller can stream it.
 */
async function generateClaim(
  userId: string,
  receipts: Receipt[],
  onEvent?: ExtractionEventHandler
) {
  const outcomes = await extractReceipts(receipts, onEvent);

  const failed = outcomes.filter((o) => o.result === null);
  if (failed.length > 0) {
    // Failed calls are logged too — bad model output is prompt-tuning gold.
    await prisma.extractionLog.createMany({
      data: outcomes.map((o) => extractionLogRow(userId, o)),
    });
    const names = failed.map((f) => f.receipt.originalName).join(", ");
    const quota = failed.some(
      (f) => isQuotaErrorMessage(f.error) || isQuotaErrorMessage(f.meta.rawResponse)
    );
    if (quota) {
      throw new ApiError(
        429,
        `AI provider rate limit / quota exhausted (target ${rpmTarget()} requests/minute). ` +
          `The server waited and retried but the quota hasn't cleared — please wait a minute ` +
          `and try again. Affected: ${names}`
      );
    }
    throw new ApiError(502, `AI extraction failed for ${names}: ${failed[0].error}`);
  }

  const extractions = outcomes.map((o, i) => {
    const r = o.result!;
    const totalCents = parseDollarsToCents(r.totalAmount);
    const refundCents = parseDollarsToCents(r.refundAmount);
    const description = composeDescription(r);
    return {
      receiptUpdate: {
        id: r.receiptId,
        merchant: r.merchant,
        purchaseDate: r.purchaseDate ?? "",
        extractedTotalCents: totalCents,
        extractedRefundCents: refundCents,
      },
      item: {
        receiptId: r.receiptId,
        description,
        // The suggested amount is a derivation of two printed numbers; the
        // review UI shows it ("charged X − refunded Y") for the human to
        // verify against what they actually paid.
        amountCents: totalCents - refundCents,
        // The model never assigns ministries; the user picks one per row
        // during review (a row cannot be verified without one).
        ministry: "",
        sortOrder: i,
        // Frozen AI snapshot for later original-vs-final comparison.
        originalDescription: description,
        originalAmountCents: totalCents - refundCents,
      },
    };
  });
  const items = extractions.map((e) => e.item);
  const totalCents = items.reduce((s, it) => s + it.amountCents, 0);

  const receiptIds = receipts.map((r) => r.id);
  const [reimbursement] = await prisma.$transaction([
    prisma.reimbursement.create({
      data: {
        userId,
        totalCents,
        receipts: { create: receiptIds.map((receiptId) => ({ receiptId })) },
        lineItems: { create: items },
      },
      include: { lineItems: true },
    }),
    ...extractions.map(({ receiptUpdate: { id, ...data } }) =>
      prisma.receipt.update({ where: { id }, data })
    ),
  ]);

  await prisma.extractionLog.createMany({
    data: outcomes.map((o) => extractionLogRow(userId, o, reimbursement.id)),
  });

  return reimbursement;
}

/** NDJSON progress line emitted while streaming; the last line is done|error. */
type StreamMessage =
  | ExtractionEvent
  | { type: "status"; phase: "extracting"; total: number }
  | { type: "done"; reimbursementId: string }
  | { type: "error"; status: number; message: string };

/**
 * "Generate Claim": extract each selected receipt and create a draft claim.
 *
 * Two response shapes, chosen by the Accept header:
 *   - `application/x-ndjson` → a stream of newline-delimited progress events
 *     (status, per-receipt completion, quota-wait notices) ending in a
 *     `done`/`error` line. The Shoebox UI uses this to show live status.
 *   - anything else → the classic JSON `{ reimbursement }` with 201 (or a JSON
 *     error), which is what the programmatic API and tests rely on.
 */
export async function POST(req: NextRequest) {
  const wantsStream = req.headers.get("accept")?.includes("application/x-ndjson") ?? false;

  if (!wantsStream) {
    return handleApi(async () => {
      const userId = await requireUserId();
      const receipts = await loadSelectedReceipts(req, userId);
      const reimbursement = await generateClaim(userId, receipts);
      return NextResponse.json({ reimbursement }, { status: 201 });
    });
  }

  // Streaming path: auth/validation errors still come back as plain JSON (the
  // client reads them before switching to stream mode); the extraction phase
  // streams NDJSON with HTTP 200 and carries any failure in the final line.
  let userId: string;
  let receipts: Receipt[];
  try {
    userId = await requireUserId();
    receipts = await loadSelectedReceipts(req, userId);
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("API error:", err);
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (msg: StreamMessage) =>
        controller.enqueue(encoder.encode(JSON.stringify(msg) + "\n"));
      try {
        send({ type: "status", phase: "extracting", total: receipts.length });
        const reimbursement = await generateClaim(userId, receipts, (ev) => send(ev));
        send({ type: "done", reimbursementId: reimbursement.id });
      } catch (err) {
        if (!(err instanceof ApiError)) console.error("Claim generation error:", err);
        send({
          type: "error",
          status: err instanceof ApiError ? err.status : 500,
          message: err instanceof Error ? err.message : "Claim generation failed",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
