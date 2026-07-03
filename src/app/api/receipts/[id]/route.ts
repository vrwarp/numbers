import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { deleteStoredFile } from "@/lib/storage";

export const runtime = "nodejs";

/** Delete a receipt from the Shoebox (only while unassigned). */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const receipt = await prisma.receipt.findFirst({ where: { id, userId } });
    if (!receipt) throw new ApiError(404, "Receipt not found");
    const inUse = await prisma.reimbursementReceipt.count({ where: { receiptId: id } });
    if (inUse > 0) throw new ApiError(409, "Receipt is part of a claim and cannot be deleted");
    await prisma.receipt.delete({ where: { id } });
    await deleteStoredFile(receipt.filePath);
    return NextResponse.json({ ok: true });
  });
}
