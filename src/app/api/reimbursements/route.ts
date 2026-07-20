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
  manualClaimRows,
  recordClaimExtractions,
} from "@/lib/claims";

import { enqueueReceiptEmbedding, enqueueClaimEmbeddingDebounced } from "@/lib/embeddings/queue";

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

const CreateSchema = z.object({
  receiptIds: z.array(z.string().min(1)).min(1),
  // Skip AI extraction and start with blank rows — the manual escape hatch.
  manual: z.boolean().optional(),
});

/** Resolve + own-check the selected receipts, or throw the right ApiError. */
async function loadSelectedReceipts(
  req: NextRequest,
  userId: string
): Promise<{ receipts: Receipt[]; manual: boolean }> {
  const body = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) throw new ApiError(400, "receiptIds (non-empty array) required", "receiptIdsRequired");
  const receiptIds = [...new Set(body.data.receiptIds)];

  const receipts = await prisma.receipt.findMany({ where: { id: { in: receiptIds }, userId } });
  if (receipts.length !== receiptIds.length) {
    throw new ApiError(404, "One or more receipts were not found", "receiptsNotFound");
  }
  // A receipt may go on any number of claims (e.g. one purchase split across
  // two filings) — processed receipts are deliberately allowed. Its stored
  // annotation (normally written by the background worker soon after upload)
  // is reused as-is; only never-annotated receipts are extracted here.
  return { receipts, manual: body.data.manual ?? false };
}

/**
 * Build the draft claim from the selected receipts: consume each receipt's
 * stored background annotation, extracting with AI only the ones the worker
 * hasn't reached (see extractClaimRows for how read failures degrade to manual
 * rows) — or, in manual mode, skip both entirely and start every row blank for
 * the user to fill in.
 */
async function generateClaim(
  userId: string,
  receipts: Receipt[],
  manual: boolean,
  onEvent?: ExtractionEventHandler
) {
  const { outcomes, extractions } = manual
    ? { outcomes: [], extractions: manualClaimRows(receipts) }
    : await extractClaimRows(userId, receipts, onEvent);
  const items = extractions.map((e) => e.item);
  const totalCents = items.reduce((s, it) => s + it.amountCents, 0);

  const claimDescription = receipts.length === 1 ? (receipts[0].note || "") : "";

  const receiptIds = receipts.map((r) => r.id);
  const [reimbursement] = await prisma.$transaction([
    prisma.reimbursement.create({
      data: {
        userId,
        totalCents,
        claimDescription,
        receipts: { create: receiptIds.map((receiptId) => ({ receiptId })) },
        lineItems: { create: items },
      },
      include: { lineItems: true },
    }),
    // Failed extractions have no receiptUpdate (their row is a manual-entry
    // placeholder) — only stamp the receipts the model actually read.
    ...extractions
      .filter((e) => e.receiptUpdate)
      .map(({ receiptUpdate }) => {
        const { id, ...data } = receiptUpdate!;
        return prisma.receipt.update({ where: { id }, data });
      }),
  ]);

  // Log fresh calls against the claim, adopt the background-annotation logs
  // that produced the consumed rows, and mark those receipts' queue jobs done.
  if (!manual) await recordClaimExtractions(userId, reimbursement.id, receipts, outcomes);

  // Search triggers (docs/SEARCH_DESIGN.md §5.2): the new draft debounces;
  // extraction restamped merchant/purchaseDate on the receipts → re-embed them.
  enqueueClaimEmbeddingDebounced(reimbursement.id, userId);
  for (const e of extractions) {
    if (e.receiptUpdate) enqueueReceiptEmbedding(e.receiptUpdate.id, userId);
  }

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
      const { receipts, manual } = await loadSelectedReceipts(req, userId);
      const reimbursement = await generateClaim(userId, receipts, manual);
      return NextResponse.json({ reimbursement }, { status: 201 });
    });
  }

  // Streaming path: auth/validation errors still come back as plain JSON (the
  // client reads them before switching to stream mode); the extraction phase
  // streams NDJSON with HTTP 200 and carries any failure in the final line.
  let userId: string;
  let receipts: Receipt[];
  let manual: boolean;
  try {
    userId = await requireUserId();
    ({ receipts, manual } = await loadSelectedReceipts(req, userId));
  } catch (err) {
    return apiErrorJson(err);
  }

  return claimProgressStream(receipts.length, async (onEvent) => {
    const reimbursement = await generateClaim(userId, receipts, manual, onEvent);
    return { reimbursementId: reimbursement.id };
  });
}
