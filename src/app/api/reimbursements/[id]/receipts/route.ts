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
  manualClaimRows,
} from "@/lib/claims";

import { enqueueClaimEmbeddingDebounced, enqueueReceiptEmbedding } from "@/lib/embeddings/queue";

export const runtime = "nodejs";
// Same budget as claim creation: extraction can sit through quota cooldowns.
export const maxDuration = 900;

const AddSchema = z.object({
  receiptIds: z.array(z.string().min(1)).min(1),
  // Skip AI extraction and start with blank rows — the manual escape hatch.
  manual: z.boolean().optional(),
});

/** Own-check the claim (draft only) and the receipts to add, or throw. */
async function loadValidated(req: NextRequest, userId: string, id: string) {
  const body = AddSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) throw new ApiError(400, "receiptIds (non-empty array) required", "receiptIdsRequired");
  const receiptIds = [...new Set(body.data.receiptIds)];

  const reimbursement = await prisma.reimbursement.findFirst({
    where: { id, userId },
    include: { receipts: { select: { receiptId: true } } },
  });
  if (!reimbursement) throw new ApiError(404, "Claim not found", "claimNotFound");
  if (reimbursement.status !== "draft") {
    throw new ApiError(409, "Claim already generated; receipts are frozen", "claimReceiptsFrozen");
  }
  if (receiptIds.some((rid) => reimbursement.receipts.some((rr) => rr.receiptId === rid))) {
    throw new ApiError(409, "One or more receipts are already on this claim", "receiptsAlreadyOnClaim");
  }

  const receipts = await prisma.receipt.findMany({ where: { id: { in: receiptIds }, userId } });
  if (receipts.length !== receiptIds.length) {
    throw new ApiError(404, "One or more receipts were not found", "receiptsNotFound");
  }
  // As at claim creation, any owned receipt qualifies regardless of status —
  // a receipt may sit on several claims. It is re-extracted for this claim,
  // overwriting the receipt's extraction metadata.
  return { receipts, manual: body.data.manual ?? false };
}

/**
 * Extract the new receipts and append them to the draft: join rows + ONE line
 * item per receipt, exactly like claim creation, then AuditEvent(add-receipt)
 * and a fresh totalCents recompute. A receipt the AI can't read becomes a
 * manual-entry placeholder rather than blocking the add; manual mode skips AI
 * entirely and starts every new row blank.
 */
async function addReceipts(
  userId: string,
  reimbursementId: string,
  receipts: Receipt[],
  manual: boolean,
  onEvent?: ExtractionEventHandler
) {
  const { outcomes, extractions } = manual
    ? { outcomes: [], extractions: manualClaimRows(receipts) }
    : await extractClaimRows(userId, receipts, onEvent);

  // Extraction can take minutes on a slow provider — re-check that the claim
  // wasn't generated (or discarded) in the meantime before writing rows.
  const current = await prisma.reimbursement.findFirst({
    where: { id: reimbursementId, userId },
    include: { lineItems: { select: { sortOrder: true } } },
  });
  if (!current) throw new ApiError(404, "Claim not found", "claimNotFound");
  if (current.status !== "draft") {
    throw new ApiError(409, "Claim already generated; receipts are frozen", "claimReceiptsFrozen");
  }

  // New rows sort after every existing row (splits renumber within a receipt,
  // so the claim-wide max keeps appended receipts at the end).
  const sortOrderStart = current.lineItems.reduce((m, it) => Math.max(m, it.sortOrder), -1) + 1;
  const items = extractions.map((e) => ({
    ...e.item,
    sortOrder: sortOrderStart + e.item.sortOrder,
    // A single-ministry claim mirrors its ministry/event onto every row, so
    // late-added receipts inherit them at creation (still unverified — the
    // human sign-off is per row).
    ...(current.singleMinistry
      ? { ministry: current.claimMinistry, event: current.claimEvent }
      : {}),
  }));

  await prisma.$transaction([
    prisma.reimbursement.update({
      where: { id: reimbursementId },
      data: {
        receipts: { create: receipts.map((r) => ({ receiptId: r.id })) },
        lineItems: { create: items },
      },
    }),
    // Failed extractions have no receiptUpdate (their row is a manual-entry
    // placeholder) — only stamp the receipts the model actually read.
    ...extractions
      .filter((e) => e.receiptUpdate)
      .map(({ receiptUpdate }) => {
        const { id, ...data } = receiptUpdate!;
        return prisma.receipt.update({ where: { id }, data });
      }),
    prisma.auditEvent.create({
      data: {
        userId,
        reimbursementId,
        action: "add-receipt",
        detail: JSON.stringify({
          addedReceipts: items.map((it) => ({
            receiptId: it.receiptId,
            originalName: receipts.find((r) => r.id === it.receiptId)?.originalName ?? "",
            description: it.description,
            amountCents: it.amountCents,
          })),
        }),
      },
    }),
  ]);

  const all = await prisma.lineItem.findMany({ where: { reimbursementId } });
  const totalCents = all.reduce((s, it) => (it.isExcluded ? s : s + it.amountCents), 0);
  await prisma.reimbursement.update({ where: { id: reimbursementId }, data: { totalCents } });

  if (outcomes.length > 0) {
    await prisma.extractionLog.createMany({
      data: outcomes.map((o) => extractionLogRow(userId, o, reimbursementId)),
    });
  }

  // Search triggers (docs/SEARCH_DESIGN.md §5.2): draft content changed +
  // extraction restamped the added receipts' merchant/purchaseDate.
  enqueueClaimEmbeddingDebounced(reimbursementId, userId);
  for (const e of extractions) {
    if (e.receiptUpdate) enqueueReceiptEmbedding(e.receiptUpdate.id, userId);
  }

  return totalCents;
}

/**
 * Add receipts to an existing DRAFT claim ("I forgot one"). Body
 * `{receiptIds[]}`; receipts already on the claim are refused (409), as is a
 * generated claim. Same two response shapes as claim creation: plain JSON
 * `{ok, totalCents}`, or an NDJSON progress stream when the client sends
 * `Accept: application/x-ndjson` (final line `{type:"done"}` carries the
 * claim id for symmetry with create).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const wantsStream = req.headers.get("accept")?.includes("application/x-ndjson") ?? false;
  const { id } = await ctx.params;

  if (!wantsStream) {
    return handleApi(async () => {
      const userId = await requireUserId();
      const { receipts, manual } = await loadValidated(req, userId, id);
      const totalCents = await addReceipts(userId, id, receipts, manual);
      return NextResponse.json({ ok: true, totalCents });
    });
  }

  let userId: string;
  let receipts: Receipt[];
  let manual: boolean;
  try {
    userId = await requireUserId();
    ({ receipts, manual } = await loadValidated(req, userId, id));
  } catch (err) {
    return apiErrorJson(err);
  }

  return claimProgressStream(receipts.length, async (onEvent) => {
    await addReceipts(userId, id, receipts, manual, onEvent);
    return { reimbursementId: id };
  });
}
