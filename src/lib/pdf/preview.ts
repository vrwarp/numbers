// Rasterize a PDF receipt into a single tall JPEG for inline display.
//
// Mobile browsers (notably Chrome on Android) have no inline PDF viewer, so an
// <object>/<iframe> PDF paints a blank box. We render the pages server-side to
// one vertical strip that displays as an ordinary <img> everywhere. This is a
// *derived preview* only — the original PDF stays authoritative (it is what the
// final packet appends and what the "open original" link serves).

/** Target width, in px, of the rendered strip. ~1000px keeps a receipt legible
 *  while staying small over the wire. */
const TARGET_WIDTH = 1000;
/** JPEG quality for the strip — receipts are high-contrast, so this is plenty. */
const JPEG_QUALITY = 0.72;
/** Pages beyond this are dropped from the preview; the original-PDF link covers
 *  them. Bounds the transient server-side canvas for pathologically long PDFs. */
export const MAX_PREVIEW_PAGES = 12;

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

    const rendered: { canvas: PreviewCanvas; width: number; height: number }[] = [];
    let stripWidth = 0;
    let stripHeight = 0;
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const unscaled = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: TARGET_WIDTH / unscaled.width });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const { canvas, context } = canvasFactory.create(width, height);
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context,
        viewport,
      }).promise;
      rendered.push({ canvas, width, height });
      stripWidth = Math.max(stripWidth, width);
      stripHeight += height;
    }

    const { canvas, context } = canvasFactory.create(stripWidth, stripHeight);
    context.fillStyle = "white";
    context.fillRect(0, 0, stripWidth, stripHeight);
    let y = 0;
    for (const p of rendered) {
      context.drawImage(p.canvas as unknown as CanvasImageSource, 0, y);
      y += p.height;
    }
    return canvas.toBuffer("image/jpeg", JPEG_QUALITY);
  } finally {
    // Release the document's worker/resources.
    await loadingTask.destroy();
  }
}

// The canvas pdfjs' node canvasFactory hands back (concretely @napi-rs/canvas)
// adds a Node-only toBuffer() on top of the standard 2D canvas surface.
interface PreviewCanvas {
  toBuffer(mime: "image/jpeg", quality: number): Buffer;
}
