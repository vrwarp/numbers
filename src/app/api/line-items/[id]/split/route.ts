import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { subtotalCents } from "@/lib/money";

import { enqueueClaimEmbeddingDebounced } from "@/lib/embeddings/queue";

export const runtime = "nodejs";

const SplitSchema = z.object({
  // Amount (in cents) to keep on the original row; the remainder moves to the
  // new row. Defaults to an even split with the odd cent staying on the original.
  firstAmountCents: z.number().int().optional(),
  // Optional attributes for the new (second) row, so a "split off a portion"
  // flow can reassign or exclude the carved-off part in one atomic step instead
  // of a split followed by a separate PATCH. Omitted fields inherit the
  // original row's values (the historical behaviour). Both halves stay
  // unverified regardless — a human still approves each. Capped at the same
  // 100 chars the row PATCH enforces so an oversized value can't slip in here.
  secondMinistry: z.string().max(100).optional(),
  secondEvent: z.string().max(100).optional(),
  secondExcluded: z.boolean().optional(),
});

/**
 * Split a bulk line item into two rows so its cost can be divided between
 * ministries (e.g. $50 Footprints + $50 High School CE). Both halves come
 * back unverified so the user must approve each explicitly.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const parsed = SplitSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) throw new ApiError(400, "Invalid split request", "invalidSplitRequest");

    const item = await prisma.lineItem.findFirst({
      where: { id, reimbursement: { userId } },
      include: { reimbursement: { select: { id: true, status: true } } },
    });
    if (!item) throw new ApiError(404, "Line item not found", "lineItemNotFound");
    if (item.reimbursement.status !== "draft") {
      throw new ApiError(409, "Claim already generated; line items are frozen", "claimFrozen");
    }

    const total = item.amountCents;
    const sign = total < 0 ? -1 : 1;
    const first = parsed.data.firstAmountCents ?? sign * Math.ceil(Math.abs(total) / 2);
    const second = total - first;
    if (first === 0 || second === 0 || Math.abs(first) + Math.abs(second) !== Math.abs(total)) {
      throw new ApiError(400, "Split amounts must be non-zero and sum to the original amount", "splitAmountsInvalid");
    }

    const [updated, created] = await prisma.$transaction([
      prisma.lineItem.update({
        where: { id },
        data: { amountCents: first, isVerified: false },
      }),
      prisma.lineItem.create({
        data: {
          reimbursementId: item.reimbursementId,
          receiptId: item.receiptId,
          description: item.description,
          amountCents: second,
          ministry: parsed.data.secondMinistry ?? item.ministry,
          event: parsed.data.secondEvent ?? item.event,
          isVerified: false,
          isExcluded: parsed.data.secondExcluded ?? item.isExcluded,
          sortOrder: item.sortOrder, // renumbered below to slot in right after the original
        },
      }),
    ]);

    await prisma.auditEvent.create({
      data: {
        userId,
        reimbursementId: item.reimbursementId,
        lineItemId: id,
        action: "split",
        detail: JSON.stringify({
          description: item.description,
          totalCents: total,
          firstAmountCents: first,
          secondAmountCents: second,
          newLineItemId: created.id,
          secondMinistry: created.ministry,
          secondEvent: created.event,
          secondExcluded: created.isExcluded,
        }),
      },
    });

    // Renumber so the new half sits directly under the original.
    const all = await prisma.lineItem.findMany({
      where: { reimbursementId: item.reimbursementId },
      orderBy: [{ sortOrder: "asc" }],
    });
    const ordered = all
      .filter((it) => it.id !== created.id)
      .flatMap((it) => (it.id === updated.id ? [it, created] : [it]));
    await prisma.$transaction(
      ordered.map((it, i) => prisma.lineItem.update({ where: { id: it.id }, data: { sortOrder: i } }))
    );

    // Recompute the claim total server-side (invariant 5): excluding one half
    // (or splitting an excluded row into an active one) changes the active
    // sum, so the stored total would otherwise drift until the next mutation.
    const rows = await prisma.lineItem.findMany({ where: { reimbursementId: item.reimbursementId } });
    const totalCents = subtotalCents(rows);
    await prisma.reimbursement.update({ where: { id: item.reimbursementId }, data: { totalCents } });

    enqueueClaimEmbeddingDebounced(item.reimbursement.id, userId);
    return NextResponse.json({ original: updated, created, totalCents }, { status: 201 });
  });
}
