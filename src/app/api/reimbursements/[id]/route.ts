import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";

export const runtime = "nodejs";

/** Full claim detail for the review screen: line items grouped client-side by receipt. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const reimbursement = await prisma.reimbursement.findFirst({
      where: { id, userId },
      include: {
        lineItems: { orderBy: { sortOrder: "asc" } },
        receipts: {
          include: {
            receipt: {
              select: {
                id: true,
                originalName: true,
                mimeType: true,
                createdAt: true,
                note: true,
                merchant: true,
                purchaseDate: true,
                extractedTotalCents: true,
                extractedRefundCents: true,
              },
            },
          },
        },
      },
    });
    if (!reimbursement) throw new ApiError(404, "Claim not found");
    return NextResponse.json({ reimbursement });
  });
}

/** Discard a draft claim; its receipts return to the Shoebox untouched. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const reimbursement = await prisma.reimbursement.findFirst({ where: { id, userId } });
    if (!reimbursement) throw new ApiError(404, "Claim not found");
    if (reimbursement.status !== "draft") throw new ApiError(409, "Only draft claims can be deleted");
    await prisma.reimbursement.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  });
}
