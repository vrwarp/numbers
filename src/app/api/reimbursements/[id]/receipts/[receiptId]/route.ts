import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";

export const runtime = "nodejs";

/**
 * Remove an accidentally-added receipt from a draft claim: its line items
 * and the claim↔receipt link are deleted, and the receipt returns to the
 * Shoebox (its status never left "unassigned" — that only changes at PDF
 * generation). Refused for the last receipt — discard the claim instead.
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; receiptId: string }> }
) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id, receiptId } = await ctx.params;

    const reimbursement = await prisma.reimbursement.findFirst({
      where: { id, userId },
      include: { receipts: { include: { receipt: { select: { originalName: true } } } } },
    });
    if (!reimbursement) throw new ApiError(404, "Claim not found");
    if (reimbursement.status !== "draft") {
      throw new ApiError(409, "Claim already generated; receipts are frozen");
    }
    const joined = reimbursement.receipts.find((rr) => rr.receiptId === receiptId);
    if (!joined) throw new ApiError(404, "Receipt not found in this claim");
    if (reimbursement.receipts.length === 1) {
      throw new ApiError(409, "This is the only receipt in the claim — discard the claim instead");
    }

    const removed = await prisma.lineItem.findMany({ where: { reimbursementId: id, receiptId } });
    await prisma.$transaction([
      prisma.lineItem.deleteMany({ where: { reimbursementId: id, receiptId } }),
      prisma.reimbursementReceipt.delete({
        where: { reimbursementId_receiptId: { reimbursementId: id, receiptId } },
      }),
      prisma.auditEvent.create({
        data: {
          userId,
          reimbursementId: id,
          action: "remove-receipt",
          detail: JSON.stringify({
            receiptId,
            originalName: joined.receipt.originalName,
            removedLineItems: removed.map((it) => ({
              id: it.id,
              description: it.description,
              amountCents: it.amountCents,
            })),
          }),
        },
      }),
    ]);

    const items = await prisma.lineItem.findMany({ where: { reimbursementId: id } });
    const totalCents = items.reduce((s, it) => (it.isExcluded ? s : s + it.amountCents), 0);
    await prisma.reimbursement.update({ where: { id }, data: { totalCents } });

    return NextResponse.json({ ok: true, totalCents });
  });
}
