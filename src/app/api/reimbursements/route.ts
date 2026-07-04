import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { extractReceipts, type ReceiptExtraction } from "@/lib/ai/extract";
import { composeDescription } from "@/lib/ai/compose";
import { parseDollarsToCents } from "@/lib/money";

export const runtime = "nodejs";
// Per-receipt AI extraction on a large claim can take a while.
export const maxDuration = 300;

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

/**
 * "Generate Claim": run each selected shoebox receipt through the LLM (one
 * call per receipt) and create a draft reimbursement with ONE unverified
 * line item per receipt — description composed from merchant/date/summary,
 * amount = printed total minus refunds. All-or-nothing: if any receipt fails
 * to extract, no claim is created — but every call is still telemetry-logged.
 */
export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const body = CreateSchema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, "receiptIds (non-empty array) required");
    const receiptIds = [...new Set(body.data.receiptIds)];

    const receipts = await prisma.receipt.findMany({ where: { id: { in: receiptIds }, userId } });
    if (receipts.length !== receiptIds.length) {
      throw new ApiError(404, "One or more receipts were not found");
    }
    const alreadyUsed = receipts.filter((r) => r.status !== "unassigned");
    if (alreadyUsed.length > 0) {
      throw new ApiError(409, `Already used in a claim: ${alreadyUsed.map((r) => r.originalName).join(", ")}`);
    }

    const outcomes = await extractReceipts(receipts);

    const failed = outcomes.filter((o) => o.result === null);
    if (failed.length > 0) {
      // Failed calls are logged too — bad model output is prompt-tuning gold.
      await prisma.extractionLog.createMany({
        data: outcomes.map((o) => extractionLogRow(userId, o)),
      });
      const names = failed.map((f) => f.receipt.originalName).join(", ");
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

    return NextResponse.json({ reimbursement }, { status: 201 });
  });
}
