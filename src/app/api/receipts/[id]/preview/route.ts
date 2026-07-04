import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import {
  readStoredFile,
  saveReceiptFile,
  previewManifestPath,
  previewPagePath,
} from "@/lib/storage";
import { renderPdfPreviewPages } from "@/lib/pdf/preview";

export const runtime = "nodejs";

interface Manifest {
  pages: number;
  omitted: number;
}

/**
 * Raster preview of a PDF receipt for inline display (mobile browsers won't
 * render an embedded PDF). Without ?page: returns the JSON manifest
 * {pages, omitted}. With ?page=N (1-based): returns that page as WebP.
 * Rendered once on first request and cached beside the original; the original
 * PDF is never touched, so the cache never goes stale. Auth: owner only.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const receipt = await prisma.receipt.findFirst({ where: { id, userId } });
    if (!receipt) throw new ApiError(404, "Receipt not found");
    if (receipt.mimeType !== "application/pdf") {
      throw new ApiError(400, "Preview is only available for PDF receipts");
    }

    // Ensure the cache: render all pages + manifest on the first request.
    let manifest = await readStoredFile(previewManifestPath(receipt.filePath))
      .then((b) => JSON.parse(b.toString("utf8")) as Manifest)
      .catch(() => null);
    if (!manifest) {
      const pdf = await readStoredFile(receipt.filePath);
      const preview = await renderPdfPreviewPages(pdf);
      for (let i = 0; i < preview.pages.length; i++) {
        await saveReceiptFile(
          userId,
          path.basename(previewPagePath(receipt.filePath, i + 1)),
          preview.pages[i]
        );
      }
      manifest = { pages: preview.pages.length, omitted: preview.omitted };
      // Manifest last: its presence marks the cache complete.
      await saveReceiptFile(
        userId,
        path.basename(previewManifestPath(receipt.filePath)),
        Buffer.from(JSON.stringify(manifest))
      );
    }

    const pageParam = req.nextUrl.searchParams.get("page");
    if (pageParam === null) {
      return NextResponse.json(manifest, {
        headers: { "Cache-Control": "private, max-age=3600" },
      });
    }
    const page = Number(pageParam);
    if (!Number.isInteger(page) || page < 1 || page > manifest.pages) {
      throw new ApiError(400, "Invalid preview page");
    }
    const webp = await readStoredFile(previewPagePath(receipt.filePath, page));
    return new NextResponse(new Uint8Array(webp), {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "private, max-age=3600",
      },
    });
  });
}
