import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";

export const runtime = "nodejs";

const PatchSchema = z
  .object({
    description: z.string().min(1).max(300),
    quantity: z.number().finite(),
    amountCents: z.number().int(),
    ministry: z.string().max(100),
    isVerified: z.boolean(),
    isExcluded: z.boolean(),
  })
  .partial();

/**
 * Edit a line item during review (verify, exclude, adjust tax/amount, change
 * ministry, ...). Any content change un-verifies the row so the human must
 * re-approve it. The claim's total is recomputed on every change.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid line item update");
    const patch = parsed.data;

    const item = await prisma.lineItem.findFirst({
      where: { id, reimbursement: { userId } },
      include: { reimbursement: { select: { status: true, id: true } } },
    });
    if (!item) throw new ApiError(404, "Line item not found");
    if (item.reimbursement.status !== "draft") {
      throw new ApiError(409, "Claim already generated; line items are frozen");
    }

    const contentChanged =
      (patch.description !== undefined && patch.description !== item.description) ||
      (patch.quantity !== undefined && patch.quantity !== item.quantity) ||
      (patch.amountCents !== undefined && patch.amountCents !== item.amountCents) ||
      (patch.ministry !== undefined && patch.ministry !== item.ministry);

    const updated = await prisma.lineItem.update({
      where: { id },
      data: {
        ...patch,
        ...(contentChanged && patch.isVerified === undefined ? { isVerified: false } : {}),
      },
    });

    const items = await prisma.lineItem.findMany({ where: { reimbursementId: item.reimbursement.id } });
    const totalCents = items.reduce((s, it) => (it.isExcluded ? s : s + it.amountCents), 0);
    await prisma.reimbursement.update({ where: { id: item.reimbursement.id }, data: { totalCents } });

    return NextResponse.json({ lineItem: updated, totalCents });
  });
}
