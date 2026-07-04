import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";

export const runtime = "nodejs";

/**
 * Revert a generated claim to draft — the escape hatch for mistakes noticed
 * after PDF generation but before the printed form is filed. The claim
 * unfreezes (rows editable, receipts removable) and its receipts return
 * from "processed" to "unassigned". Rows keep their verified state: values
 * were frozen at generation, so the attestations still hold until edited.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;

    const reimbursement = await prisma.reimbursement.findFirst({
      where: { id, userId },
      include: { receipts: true },
    });
    if (!reimbursement) throw new ApiError(404, "Claim not found");
    if (reimbursement.status !== "generated") {
      throw new ApiError(409, "Only generated claims can be reverted to draft");
    }

    const receiptIds = reimbursement.receipts.map((rr) => rr.receiptId);
    await prisma.$transaction([
      prisma.reimbursement.update({ where: { id }, data: { status: "draft" } }),
      prisma.receipt.updateMany({
        where: { id: { in: receiptIds } },
        data: { status: "unassigned" },
      }),
      prisma.auditEvent.create({
        data: {
          userId,
          reimbursementId: id,
          action: "revert-to-draft",
          detail: JSON.stringify({ receiptIds }),
        },
      }),
    ]);

    return NextResponse.json({ ok: true });
  });
}
