import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Receipt } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import type { ExtractionEventHandler } from "@/lib/ai/extract";
import {
  apiErrorJson,
  claimProgressStream,
  extractClaimRows,
  extractionLogRow,
} from "@/lib/claims";

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
 * Extract every selected receipt (see extractClaimRows for the all-or-nothing
 * failure handling) and create the draft claim.
 */
async function generateClaim(
  userId: string,
  receipts: Receipt[],
  onEvent?: ExtractionEventHandler
) {
  const { outcomes, extractions } = await extractClaimRows(userId, receipts, onEvent);
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
    return apiErrorJson(err);
  }

  return claimProgressStream(receipts.length, async (onEvent) => {
    const reimbursement = await generateClaim(userId, receipts, onEvent);
    return { reimbursementId: reimbursement.id };
  });
}
