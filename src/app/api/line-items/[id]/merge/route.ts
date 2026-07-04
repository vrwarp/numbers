import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";

export const runtime = "nodejs";

/**
 * Undo a split: fold this row back into the row directly above it from the
 * same receipt. Amounts are summed onto the surviving (upper) row, which
 * keeps its own description/ministry/event and original* snapshot but comes
 * back unverified so the human re-approves the combined amount.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;

    const item = await prisma.lineItem.findFirst({
      where: { id, reimbursement: { userId } },
      include: { reimbursement: { select: { id: true, status: true } } },
    });
    if (!item) throw new ApiError(404, "Line item not found");
    if (item.reimbursement.status !== "draft") {
      throw new ApiError(409, "Claim already generated; line items are frozen");
    }

    // The split route slots the new half right under the original, so "the
    // row above from the same receipt" is the natural merge target. Merging
    // into the upper row also preserves the AI's original* snapshot, which
    // lives on the original (upper) half.
    const target = await prisma.lineItem.findFirst({
      where: {
        reimbursementId: item.reimbursementId,
        receiptId: item.receiptId,
        sortOrder: { lt: item.sortOrder },
        id: { not: id },
      },
      orderBy: { sortOrder: "desc" },
    });
    if (!target) throw new ApiError(400, "No row above from the same receipt to merge into");
    if (item.isExcluded || target.isExcluded) {
      throw new ApiError(400, "Restore the excluded row before merging");
    }

    const [merged] = await prisma.$transaction([
      prisma.lineItem.update({
        where: { id: target.id },
        data: { amountCents: target.amountCents + item.amountCents, isVerified: false },
      }),
      prisma.lineItem.delete({ where: { id } }),
    ]);

    await prisma.auditEvent.create({
      data: {
        userId,
        reimbursementId: item.reimbursementId,
        lineItemId: target.id,
        action: "merge",
        detail: JSON.stringify({
          description: target.description,
          mergedLineItemId: item.id,
          mergedDescription: item.description,
          mergedAmountCents: item.amountCents,
          targetAmountCents: target.amountCents,
          resultAmountCents: merged.amountCents,
        }),
      },
    });

    // Close the sortOrder gap left by the deleted row.
    const all = await prisma.lineItem.findMany({
      where: { reimbursementId: item.reimbursementId },
      orderBy: [{ sortOrder: "asc" }],
    });
    await prisma.$transaction(
      all.map((it, i) => prisma.lineItem.update({ where: { id: it.id }, data: { sortOrder: i } }))
    );

    const totalCents = all.reduce((s, it) => (it.isExcluded ? s : s + it.amountCents), 0);
    await prisma.reimbursement.update({
      where: { id: item.reimbursementId },
      data: { totalCents },
    });

    return NextResponse.json({ lineItem: merged, totalCents });
  });
}
