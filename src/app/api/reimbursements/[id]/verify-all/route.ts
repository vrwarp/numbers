import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";

import { enqueueClaimEmbeddingDebounced } from "@/lib/embeddings/queue";

export const runtime = "nodejs";

/**
 * Bulk counterpart of the per-row verify PATCH: confirm every remaining
 * ministry-complete, non-excluded row in one request. The review screen's
 * "verify all" otherwise serializes N PATCHes through its mutation queue,
 * which a following PDF generation must drain — one roundtrip keeps that
 * gate instant. Same rules as the single-row route: human sign-off only
 * (ministry already chosen — rows without one are simply left alone, the
 * client offers them for individual review), drafts only, and the audit
 * trail records one event per row exactly as N individual verifies would.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;

    const reimbursement = await prisma.reimbursement.findFirst({
      where: { id, userId },
      include: { lineItems: true },
    });
    if (!reimbursement) throw new ApiError(404, "Claim not found", "claimNotFound");
    if (reimbursement.status !== "draft") {
      throw new ApiError(409, "Claim already generated; line items are frozen", "claimFrozen");
    }

    const rows = reimbursement.lineItems.filter(
      (it) => !it.isExcluded && !it.isVerified && it.ministry.trim()
    );
    if (rows.length > 0) {
      await prisma.$transaction([
        prisma.lineItem.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { isVerified: true },
        }),
        prisma.auditEvent.createMany({
          data: rows.map((r) => ({
            userId,
            reimbursementId: id,
            lineItemId: r.id,
            action: "update",
            detail: JSON.stringify({ changes: { isVerified: { from: false, to: true } } }),
          })),
        }),
      ]);
    }

    // Verification doesn't move money, but invariant 5 says every line-item
    // mutation ends with a server-side recompute — keep the habit uniform.
    const items = await prisma.lineItem.findMany({
      where: { reimbursementId: id },
      // Same order as the review GET — the client swaps its rows wholesale.
      orderBy: { sortOrder: "asc" },
    });
    const totalCents = items.reduce((s, it) => (it.isExcluded ? s : s + it.amountCents), 0);
    await prisma.reimbursement.update({ where: { id }, data: { totalCents } });

    enqueueClaimEmbeddingDebounced(id, userId);
    return NextResponse.json({ lineItems: items, totalCents, verified: rows.length });
  });
}
