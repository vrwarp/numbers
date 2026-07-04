import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { readStoredFile, saveReceiptFile } from "@/lib/storage";
import { ImageTransformError, transformReceiptImage } from "@/lib/image";

export const runtime = "nodejs";

const CropSchema = z
  .object({
    left: z.number().min(0).max(1),
    top: z.number().min(0).max(1),
    width: z.number().min(0.05).max(1),
    height: z.number().min(0.05).max(1),
  })
  // Small epsilon: the fractions arrive through client float arithmetic.
  .refine((c) => c.left + c.width <= 1.001 && c.top + c.height <= 1.001, {
    message: "Crop region exceeds the image bounds",
  });

const BodySchema = z.object({
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  crop: CropSchema.optional(),
  // Discard the current edits and restore the pristine uploaded image. When set
  // the rotate/crop fields are ignored.
  restore: z.boolean().optional(),
  // Optional: which claim the edit was made from, so the tuning trail
  // (extraction-logs detail) picks the event up alongside the row edits.
  reimbursementId: z.string().optional(),
});

/** DATA_DIR-relative path of the pristine-original sidecar, e.g.
 *  uploads/<userId>/<id>.orig.jpg alongside <id>.jpg. */
function originalSidecarName(filePath: string): string {
  const base = path.basename(filePath);
  const ext = path.extname(base);
  return `${base.slice(0, base.length - ext.length)}.orig${ext}`;
}

/** Report whether an earlier (pristine) version exists to restore. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const receipt = await prisma.receipt.findFirst({
      where: { id, userId },
      select: { id: true, originalFilePath: true },
    });
    if (!receipt) throw new ApiError(404, "Receipt not found");
    return NextResponse.json({ hasOriginal: receipt.originalFilePath != null });
  });
}

/**
 * Rotate/crop a receipt image, or (with `restore`) put the pristine uploaded
 * image back. The first edit copies the current file to a sidecar so it can be
 * restored; later edits keep pointing at that same pristine copy. Overwriting
 * the stored file is refused while any GENERATED claim holds the receipt: its
 * frozen PDF packet must keep re-downloading with the appendix images it was
 * filed with.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid image edit");
    const { rotate, crop, restore, reimbursementId } = parsed.data;
    if (!restore && rotate === 0 && !crop) throw new ApiError(400, "Nothing to change");

    const receipt = await prisma.receipt.findFirst({ where: { id, userId } });
    if (!receipt) throw new ApiError(404, "Receipt not found");
    if (!receipt.mimeType.startsWith("image/")) {
      throw new ApiError(400, "Only image receipts can be rotated or cropped");
    }
    if (receipt.status === "processed") {
      throw new ApiError(
        409,
        "This receipt is on a generated claim — revert that claim before editing the image"
      );
    }

    let claimIdForAudit: string | null = null;
    if (reimbursementId) {
      const claim = await prisma.reimbursement.findFirst({
        where: { id: reimbursementId, userId, receipts: { some: { receiptId: id } } },
      });
      if (!claim) throw new ApiError(404, "Claim not found");
      claimIdForAudit = claim.id;
    }

    if (restore) {
      if (!receipt.originalFilePath) {
        throw new ApiError(400, "This receipt has no earlier version to restore");
      }
      const originalBytes = await readStoredFile(receipt.originalFilePath);
      await saveReceiptFile(userId, path.basename(receipt.filePath), originalBytes);
      const updated = await prisma.receipt.update({
        where: { id },
        data: { sizeBytes: originalBytes.length },
        select: { id: true, sizeBytes: true },
      });
      await prisma.auditEvent.create({
        data: {
          userId,
          reimbursementId: claimIdForAudit,
          action: "restore-receipt-image",
          detail: JSON.stringify({ receiptId: id, originalName: receipt.originalName }),
        },
      });
      return NextResponse.json({ receipt: updated });
    }

    const original = await readStoredFile(receipt.filePath);
    let edited;
    try {
      edited = await transformReceiptImage(original, { rotate, crop });
    } catch (err) {
      if (err instanceof ImageTransformError) throw new ApiError(400, err.message);
      throw err;
    }

    // Preserve the pristine upload the first time we overwrite it, so it stays
    // restorable no matter how many edits pile up on top.
    let originalFilePath = receipt.originalFilePath;
    if (!originalFilePath) {
      originalFilePath = await saveReceiptFile(
        userId,
        originalSidecarName(receipt.filePath),
        original
      );
    }

    await saveReceiptFile(userId, path.basename(receipt.filePath), edited.data);
    const updated = await prisma.receipt.update({
      where: { id },
      data: { sizeBytes: edited.data.length, originalFilePath },
      select: { id: true, sizeBytes: true },
    });

    await prisma.auditEvent.create({
      data: {
        userId,
        reimbursementId: claimIdForAudit,
        action: "edit-receipt-image",
        detail: JSON.stringify({
          receiptId: id,
          originalName: receipt.originalName,
          rotate,
          crop: crop ?? null,
        }),
      },
    });

    return NextResponse.json({ receipt: updated });
  });
}
