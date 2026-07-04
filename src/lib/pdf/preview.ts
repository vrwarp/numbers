// Rasterize a PDF receipt into per-page WebP images for inline display.
//
// Mobile browsers (notably Chrome on Android) have no inline PDF viewer, so an
// <object>/<iframe> PDF paints a blank box. We render the pages server-side and
// the client stacks them as ordinary <img>s. These are *derived previews* only —
// the original PDF stays authoritative (it is what the final packet appends and
// what the "open original" link serves).

import sharp from "sharp";

/** Render density. Receipt line items are often 7–8pt, so a low density turns
 *  them to mush — ~300 DPI keeps the smallest text sharp in-card and zoomed.
 *  Per-page rendering means no whole-document canvas, so no strip ceiling. */
const PREVIEW_DPI = 300;
/** Hard cap on a page's rendered width (px) so one large-format page can't
 *  blow up its canvas; a Letter page at 300 DPI is ~2550px, under this. */
const MAX_PAGE_WIDTH = 2600;
/** Per-page size budget, mirroring the ~100 KB/image target of the photo
 *  pipeline. Each page is WebP-encoded at the highest quality on the ladder
 *  that fits the budget. (sharp's WebP quality floor is 1, so the requested
 *  10→5→0 ladder bottoms out at 1.) */
const PAGE_TARGET_BYTES = 100 * 1024;
const WEBP_QUALITY_LADDER = [10, 5, 1];
const WEBP_EFFORT = 4;
/** Only the first this-many pages are rasterized; the client shows a
 *  "+N more pages" note (from the manifest's `omitted`) for the rest. */
export const MAX_PREVIEW_PAGES = 10;

export interface PdfPreview {
  /** One WebP image per rendered page, in page order. */
  pages: Buffer[];
  /** Pages beyond MAX_PREVIEW_PAGES that were not rendered. */
  omitted: number;
}

/**
 * Render a PDF into per-page WebP images. Throws if the bytes are not a
 * readable PDF.
 */
export async function renderPdfPreviewPages(pdf: Buffer | Uint8Array): Promise<PdfPreview> {
  // Dynamic import keeps pdfjs (and its native canvas backend) out of any
  // client/edge bundle; this module is only ever reached from a nodejs route.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs rejects a Node Buffer (a Uint8Array subclass) — hand it a plain
  // Uint8Array copy so callers can pass either.
  const data = new Uint8Array(pdf.byteLength);
  data.set(pdf);
  const loadingTask = pdfjs.getDocument({ data, verbosity: 0 });
  const doc = await loadingTask.promise;
  try {
    const canvasFactory = doc.canvasFactory as {
      create: (w: number, h: number) => { canvas: unknown; context: CanvasRenderingContext2D };
      destroy?: (c: { canvas: unknown; context: CanvasRenderingContext2D }) => void;
    };
    const pageCount = Math.min(doc.numPages, MAX_PREVIEW_PAGES);
    const omitted = doc.numPages - pageCount;

    const pages: Buffer[] = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const unscaled = page.getViewport({ scale: 1 });
      // Scale for the target DPI (PDF user units are 1/72"), capped per page.
      const scale = Math.min(PREVIEW_DPI / 72, MAX_PAGE_WIDTH / unscaled.width);
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const target = canvasFactory.create(width, height);
      // White base: pages may carry transparency, and WebP keeps alpha.
      target.context.fillStyle = "white";
      target.context.fillRect(0, 0, width, height);
      await page.render({
        canvas: target.canvas as HTMLCanvasElement,
        canvasContext: target.context,
        viewport,
      }).promise;
      const raw = target.context.getImageData(0, 0, width, height);
      canvasFactory.destroy?.(target);
      pages.push(await encodePage(Buffer.from(raw.data.buffer, 0, raw.data.byteLength), width, height));
    }
    return { pages, omitted };
  } finally {
    // Release the document's worker/resources.
    await loadingTask.destroy();
  }
}

/** Encode one rendered page (raw RGBA) as WebP within the per-page budget. */
async function encodePage(rgba: Buffer, width: number, height: number): Promise<Buffer> {
  const base = sharp(rgba, { raw: { width, height, channels: 4 } }).flatten({
    background: "white",
  });
  let out: Buffer | null = null;
  for (const quality of WEBP_QUALITY_LADDER) {
    out = await base.clone().webp({ quality, effort: WEBP_EFFORT }).toBuffer();
    if (out.length <= PAGE_TARGET_BYTES) break;
  }
  if (!out) throw new Error("PDF page encoding produced no output");
  return out;
}
