import path from "path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { readStoredFile, saveReceiptFile, previewCachePath } from "@/lib/storage";
import { renderPdfToPreviewJpeg } from "@/lib/pdf/preview";

export const runtime = "nodejs";

/**
 * Serve a raster preview (JPEG) of a PDF receipt for inline display, since
 * mobile browsers won't render an embedded PDF. Rendered once on first request
 * and cached beside the original; the original PDF is never touched, so the
 * cache never goes stale (PDFs can't be rotated/cropped). Auth: owner only.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const receipt = await prisma.receipt.findFirst({ where: { id, userId } });
    if (!receipt) throw new ApiError(404, "Receipt not found");
    if (receipt.mimeType !== "application/pdf") {
      throw new ApiError(400, "Preview is only available for PDF receipts");
    }

    const cacheRel = previewCachePath(receipt.filePath);
    let jpeg = await readStoredFile(cacheRel).catch(() => null);
    if (!jpeg) {
      const pdf = await readStoredFile(receipt.filePath);
      jpeg = await renderPdfToPreviewJpeg(pdf);
      await saveReceiptFile(userId, path.basename(cacheRel), jpeg);
    }

    return new NextResponse(new Uint8Array(jpeg), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=3600",
      },
    });
  });
}
