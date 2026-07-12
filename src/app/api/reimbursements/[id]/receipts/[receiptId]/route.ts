import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { composeDescription } from "@/lib/ai/compose";
import { computeLineItemChanges } from "@/lib/audit";
import { parseDollarsToCents } from "@/lib/money";

export const runtime = "nodejs";

// Same five fields the LLM is asked to transcribe (see src/lib/ai/schema.ts),
// as the user types them in the manual-entry dialog: amounts in dollars, an
// empty purchaseDate when it can't be read.
const ManualEntrySchema = z.object({
  merchant: z.string().min(1).max(200),
  purchaseDate: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
  totalAmount: z.number().finite(),
  refundAmount: z.number().finite().min(0),
  summary: z.string().min(1).max(200),
});

/**
 * Manually supply the receipt-level fields the AI couldn't read, turning a
 * failed-extraction placeholder row into a normal one: the receipt is stamped
 * (merchant, date, printed totals) and its single line item gets the composed
 * description and net amount, exactly as a successful extraction would have.
 * The row stays unverified with no ministry — the human still signs off in
 * review. Only valid on a draft claim, and only for a receipt whose row is
 * still an un-split placeholder.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; receiptId: string }> }
) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id, receiptId } = await ctx.params;
    const parsed = ManualEntrySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid manual-entry fields", "invalidManualEntry");
    const { merchant, purchaseDate, totalAmount, refundAmount, summary } = parsed.data;

    const reimbursement = await prisma.reimbursement.findFirst({
      where: { id, userId },
      include: { receipts: { select: { receiptId: true } } },
    });
    if (!reimbursement) throw new ApiError(404, "Claim not found", "claimNotFound");
    if (reimbursement.status !== "draft") {
      throw new ApiError(409, "Claim already generated; line items are frozen", "claimFrozen");
    }
    if (!reimbursement.receipts.some((rr) => rr.receiptId === receiptId)) {
      throw new ApiError(404, "Receipt not found in this claim", "receiptNotOnClaim");
    }

    // The placeholder is the receipt's lone row; if it has been split already
    // there is no single row to fill — edit the rows directly instead.
    const rows = await prisma.lineItem.findMany({ where: { reimbursementId: id, receiptId } });
    if (rows.length !== 1) {
      throw new ApiError(409, "This receipt's row has already been edited — adjust it directly", "rowAlreadyEdited");
    }
    const row = rows[0];

    const totalCents = parseDollarsToCents(totalAmount);
    const refundCents = parseDollarsToCents(refundAmount);
    const description = composeDescription({
      receiptId,
      merchant,
      purchaseDate: purchaseDate || null,
      totalAmount,
      refundAmount,
      summary,
    });
    const patch = { description, amountCents: totalCents - refundCents };
    const changes = computeLineItemChanges(row, patch);

    const [, updated] = await prisma.$transaction([
      prisma.receipt.update({
        where: { id: receiptId },
        data: {
          merchant,
          purchaseDate,
          extractedTotalCents: totalCents,
          extractedRefundCents: refundCents,
        },
      }),
      prisma.lineItem.update({ where: { id: row.id }, data: patch }),
      prisma.auditEvent.create({
        data: {
          userId,
          reimbursementId: id,
          lineItemId: row.id,
          action: "manual-entry",
          detail: JSON.stringify({ receiptId, merchant, changes }),
        },
      }),
    ]);

    const items = await prisma.lineItem.findMany({ where: { reimbursementId: id } });
    const totalClaimCents = items.reduce((s, it) => (it.isExcluded ? s : s + it.amountCents), 0);
    await prisma.reimbursement.update({ where: { id }, data: { totalCents: totalClaimCents } });

    return NextResponse.json({ lineItem: updated, totalCents: totalClaimCents });
  });
}

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
    if (!reimbursement) throw new ApiError(404, "Claim not found", "claimNotFound");
    if (reimbursement.status !== "draft") {
      throw new ApiError(409, "Claim already generated; receipts are frozen", "claimReceiptsFrozen");
    }
    const joined = reimbursement.receipts.find((rr) => rr.receiptId === receiptId);
    if (!joined) throw new ApiError(404, "Receipt not found in this claim", "receiptNotOnClaim");
    if (reimbursement.receipts.length === 1) {
      throw new ApiError(409, "This is the only receipt in the claim — discard the claim instead", "lastReceiptOnClaim");
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
