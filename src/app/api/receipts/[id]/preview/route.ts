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
import { hasRoleReadGrant } from "@/lib/roles";
import { canReadReceiptViaTeam } from "@/lib/teams-catalog";

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
    // Owner, the ratified role-read grant (docs/SEARCH_DESIGN.md §6.3), or the
    // team read grant (§6.3 team amendment) — search results must render
    // foreign PDF thumbnails for anyone whose scope shows them.
    let receipt = await prisma.receipt.findFirst({ where: { id, userId } });
    if (
      !receipt &&
      ((await hasRoleReadGrant(userId)) || (await canReadReceiptViaTeam(userId, id)))
    ) {
      receipt = await prisma.receipt.findUnique({ where: { id } });
    }
    if (!receipt) throw new ApiError(404, "Receipt not found", "receiptNotFound");
    if (receipt.mimeType !== "application/pdf") {
      throw new ApiError(400, "Preview is only available for PDF receipts", "previewPdfOnly");
    }

    // Ensure the cache: render all pages + manifest on the first request.
    let manifest = await readStoredFile(previewManifestPath(receipt.filePath))
      .then((b) => JSON.parse(b.toString("utf8")) as Manifest)
      .catch(() => null);
    if (!manifest) {
      const pdf = await readStoredFile(receipt.filePath);
      const preview = await renderPdfPreviewPages(pdf);
      for (let i = 0; i < preview.pages.length; i++) {
        // Cache lives beside the ORIGINAL (owner's dir) — a role-holder
        // viewer must not fork a cache into their own uploads folder.
        await saveReceiptFile(
          receipt.userId,
          path.basename(previewPagePath(receipt.filePath, i + 1)),
          preview.pages[i]
        );
      }
      manifest = { pages: preview.pages.length, omitted: preview.omitted };
      // Manifest last: its presence marks the cache complete.
      await saveReceiptFile(
        receipt.userId,
        path.basename(previewManifestPath(receipt.filePath)),
        Buffer.from(JSON.stringify(manifest))
      );
    }

    const pageParam = req.nextUrl.searchParams.get("page");
    if (pageParam === null) {
      return NextResponse.json(manifest, {
        // Derived from the original PDF, which is never edited — the preview
        // cache (manifest included) genuinely cannot go stale.
        headers: { "Cache-Control": "private, max-age=31536000, immutable" },
      });
    }
    const page = Number(pageParam);
    if (!Number.isInteger(page) || page < 1 || page > manifest.pages) {
      throw new ApiError(400, "Invalid preview page", "invalidPreviewPage");
    }
    const webp = await readStoredFile(previewPagePath(receipt.filePath, page));
    return new NextResponse(new Uint8Array(webp), {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  });
}
