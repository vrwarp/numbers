// Rasterize a PDF receipt into a single tall JPEG for inline display.
//
// Mobile browsers (notably Chrome on Android) have no inline PDF viewer, so an
// <object>/<iframe> PDF paints a blank box. We render the pages server-side to
// one vertical strip that displays as an ordinary <img> everywhere. This is a
// *derived preview* only — the original PDF stays authoritative (it is what the
// final packet appends and what the "open original" link serves).

/** Render density. Receipt line items are often 7–8pt, so a fixed narrow width
 *  (a Letter page at ~118 DPI) turned them to mush — render at ~300 DPI so the
 *  smallest text is sharp and spends the ~100 KB/page budget below. Long docs
 *  are scaled down to stay within MAX_STRIP_PIXELS. */
const PREVIEW_DPI = 300;
/** Hard cap on a page's rendered width (px) so a large-format page can't blow
 *  up the strip; a Letter page at 300 DPI is ~2550px, under this. */
const MAX_PAGE_WIDTH = 2600;
/** Ceiling on the whole strip's pixel count (~40 MP ≈ a 160 MB canvas). A few
 *  pages render at full DPI; a pathologically long one is scaled down uniformly
 *  to fit rather than exhausting server memory. */
const MAX_STRIP_PIXELS = 40_000_000;
/** Per-page size budget, mirroring the ~100 KB/image target of the photo
 *  pipeline. The strip is JPEG-encoded at the highest quality on the ladder
 *  whose total size stays within this × (rendered page count); crisp vector
 *  text lands near it, photographed pages step down to fit. */
const PER_PAGE_TARGET_BYTES = 100 * 1024;
const JPEG_QUALITY_LADDER = [0.92, 0.86, 0.8, 0.74, 0.68];
/** Only the first this-many pages are rasterized; the rest get a bailout notice
 *  (with the omitted count) at the foot of the strip. */
export const MAX_PREVIEW_PAGES = 10;
/** Height (px) of the "N more pages" notice band appended when truncating. */
const NOTICE_BAND_HEIGHT = 150;

/**
 * Render a PDF into one tall JPEG (pages stacked vertically, white background).
 * Throws if the bytes are not a readable PDF.
 */
export async function renderPdfToPreviewJpeg(pdf: Buffer | Uint8Array): Promise<Buffer> {
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
      create: (w: number, h: number) => { canvas: PreviewCanvas; context: CanvasRenderingContext2D };
    };
    const pageCount = Math.min(doc.numPages, MAX_PREVIEW_PAGES);
    const omittedPages = doc.numPages - pageCount;

    // First pass: pick each page's target scale (DPI, capped per-page width) and
    // measure the total pixel area — getViewport is cheap, no rasterization.
    const sized = [];
    let targetArea = 0;
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const unscaled = page.getViewport({ scale: 1 });
      const scale = Math.min(PREVIEW_DPI / 72, MAX_PAGE_WIDTH / unscaled.width);
      sized.push({ page, scale });
      targetArea += Math.ceil(unscaled.width * scale) * Math.ceil(unscaled.height * scale);
    }
    // Scale the whole strip down uniformly if it would exceed the memory ceiling.
    const shrink = targetArea > MAX_STRIP_PIXELS ? Math.sqrt(MAX_STRIP_PIXELS / targetArea) : 1;

    // Second pass: final viewports + vertical offsets for the stacked strip.
    const pages = [];
    let stripWidth = 0;
    let contentHeight = 0;
    for (const { page, scale } of sized) {
      const viewport = page.getViewport({ scale: scale * shrink });
      pages.push({ page, viewport, top: contentHeight });
      stripWidth = Math.max(stripWidth, Math.ceil(viewport.width));
      contentHeight += Math.ceil(viewport.height);
    }
    const noticeHeight = omittedPages > 0 ? NOTICE_BAND_HEIGHT : 0;

    // One canvas for the whole strip; each page renders at its vertical offset
    // via a translate transform (no per-page canvas to hold).
    const { canvas, context } = canvasFactory.create(stripWidth, contentHeight + noticeHeight);
    context.fillStyle = "white";
    context.fillRect(0, 0, stripWidth, contentHeight + noticeHeight);
    for (const { page, viewport, top } of pages) {
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context,
        viewport,
        transform: [1, 0, 0, 1, 0, top],
      }).promise;
    }
    if (omittedPages > 0) drawTruncationNotice(context, stripWidth, contentHeight, omittedPages);

    // Encode at the highest ladder quality that fits ~100 KB/page.
    const budget = PER_PAGE_TARGET_BYTES * pageCount;
    let out = canvas.toBuffer("image/jpeg", JPEG_QUALITY_LADDER[0]);
    for (const quality of JPEG_QUALITY_LADDER.slice(1)) {
      if (out.length <= budget) break;
      out = canvas.toBuffer("image/jpeg", quality);
    }
    return out;
  } finally {
    // Release the document's worker/resources.
    await loadingTask.destroy();
  }
}

/** Draw the "N more pages not shown" band at the foot of the strip. Uses the
 *  DejaVu font shipped in the Docker runtime (see Dockerfile) so it renders even
 *  in a font-less slim image; fontconfig maps the sans-serif fallback locally. */
function drawTruncationNotice(
  ctx: CanvasRenderingContext2D,
  width: number,
  top: number,
  omitted: number,
) {
  ctx.fillStyle = "#f5f5f4";
  ctx.fillRect(0, top, width, NOTICE_BAND_HEIGHT);
  ctx.fillStyle = "#d6d3d1";
  ctx.fillRect(0, top, width, 3); // divider from the last page
  ctx.fillStyle = "#57534e";
  ctx.font = '500 40px "DejaVu Sans", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const noun = omitted === 1 ? "page" : "pages";
  const it = omitted === 1 ? "it" : "them";
  ctx.fillText(
    `+${omitted} more ${noun} not shown — open the PDF receipt to view ${it}.`,
    width / 2,
    top + NOTICE_BAND_HEIGHT / 2,
  );
}

// The canvas pdfjs' node canvasFactory hands back (concretely @napi-rs/canvas)
// adds a Node-only toBuffer() on top of the standard 2D canvas surface.
interface PreviewCanvas {
  toBuffer(mime: "image/jpeg", quality: number): Buffer;
}
