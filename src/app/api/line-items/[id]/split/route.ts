import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";

export const runtime = "nodejs";

const SplitSchema = z.object({
  // Amount (in cents) to keep on the original row; the remainder moves to the
  // new row. Defaults to an even split with the odd cent staying on the original.
  firstAmountCents: z.number().int().optional(),
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
    if (!parsed.success) throw new ApiError(400, "Invalid split request");

    const item = await prisma.lineItem.findFirst({
      where: { id, reimbursement: { userId } },
      include: { reimbursement: { select: { id: true, status: true } } },
    });
    if (!item) throw new ApiError(404, "Line item not found");
    if (item.reimbursement.status !== "draft") {
      throw new ApiError(409, "Claim already generated; line items are frozen");
    }

    const total = item.amountCents;
    const sign = total < 0 ? -1 : 1;
    const first = parsed.data.firstAmountCents ?? sign * Math.ceil(Math.abs(total) / 2);
    const second = total - first;
    if (first === 0 || second === 0 || Math.abs(first) + Math.abs(second) !== Math.abs(total)) {
      throw new ApiError(400, "Split amounts must be non-zero and sum to the original amount");
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
          quantity: item.quantity,
          amountCents: second,
          ministry: item.ministry,
          isVerified: false,
          isExcluded: item.isExcluded,
          sortOrder: item.sortOrder, // renumbered below to slot in right after the original
        },
      }),
    ]);

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

    return NextResponse.json({ original: updated, created }, { status: 201 });
  });
}
