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
    // Extended by the e-sign workflow (docs/ESIGN_DESIGN.md §6.1): any
    // frozen-but-unpaid claim may revert; the collected signatures void by
    // hash mismatch once the packet is regenerated. Paid is terminal.
    if (!["generated", "submitted", "rejected", "approved"].includes(reimbursement.status)) {
      throw new ApiError(409, "Only generated or under-signature claims can be reverted to draft");
    }

    const receiptIds = reimbursement.receipts.map((rr) => rr.receiptId);
    // "processed" means "on ≥1 claim in a FROZEN status" — only release
    // receipts that no OTHER frozen claim still holds (a receipt inside a
    // submitted/approved/paid claim backs live signatures and must keep its
    // image-edit lock).
    const heldElsewhere = await prisma.reimbursementReceipt.findMany({
      where: {
        receiptId: { in: receiptIds },
        reimbursementId: { not: id },
        reimbursement: { status: { in: ["generated", "submitted", "rejected", "approved", "paid"] } },
      },
      select: { receiptId: true },
    });
    const held = new Set(heldElsewhere.map((rr) => rr.receiptId));
    const releasable = receiptIds.filter((rid) => !held.has(rid));
    await prisma.$transaction([
      prisma.reimbursement.update({
        where: { id },
        // approverUserId is mirror routing for the (now void) submission;
        // packetSha256/ledger fields stay — they are provenance for the
        // retained signed archives.
        data: { status: "draft", approverUserId: null, pendingActionsJson: "{}" },
      }),
      prisma.receipt.updateMany({
        where: { id: { in: releasable } },
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
