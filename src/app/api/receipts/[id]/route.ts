import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { deleteStoredFile, deletePreviewCache } from "@/lib/storage";
import { enqueueReceiptEmbedding, deleteEmbeddingsFor } from "@/lib/embeddings/queue";

export const runtime = "nodejs";

const PatchSchema = z.object({ note: z.string().max(300) });

/** Edit the receipt's user note. Allowed in any state — the note is the
 *  user's own metadata and is not part of the claim's audited trail. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid receipt update", "invalidReceiptUpdate");
    const receipt = await prisma.receipt.findFirst({ where: { id, userId } });
    if (!receipt) throw new ApiError(404, "Receipt not found", "receiptNotFound");
    const updated = await prisma.receipt.update({
      where: { id },
      data: { note: parsed.data.note.trim() },
      select: { id: true, note: true },
    });
    // The note is embedded text (docs/SEARCH_DESIGN.md §5.1) → re-index.
    enqueueReceiptEmbedding(id, userId);
    return NextResponse.json({ receipt: updated });
  });
}

/** Delete a receipt from the Shoebox (only while unassigned). */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const receipt = await prisma.receipt.findFirst({ where: { id, userId } });
    if (!receipt) throw new ApiError(404, "Receipt not found", "receiptNotFound");
    const inUse = await prisma.reimbursementReceipt.count({ where: { receiptId: id } });
    if (inUse > 0) throw new ApiError(409, "Receipt is part of a claim and cannot be deleted", "receiptOnClaim");
    await prisma.receipt.delete({ where: { id } });
    await deleteEmbeddingsFor("receipt", id);
    await deleteStoredFile(receipt.filePath);
    if (receipt.originalFilePath) await deleteStoredFile(receipt.originalFilePath);
    // Best-effort: drop the cached raster preview if this was a PDF (no-op otherwise).
    await deletePreviewCache(receipt.filePath);
    return NextResponse.json({ ok: true });
  });
}
