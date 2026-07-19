"use client";

/**
 * Client-side pdf.js rendering for the click-to-stamp signing surface
 * (docs/ESIGN_DESIGN.md click-to-stamp). Rendering the *exact* packet bytes
 * in the browser — never a server raster — is what keeps the approver's
 * "you see what you sign" guarantee intact while giving pixel→point mapping
 * for placement. Lazy-loaded only by the ceremony components.
 */

// pdf.js v6 uses the very new TC39 Map/WeakMap `getOrInsert(Computed)`
// proposal, which isn't in shipping browsers yet — polyfill it before the
// library loads so rendering doesn't throw "getOrInsertComputed is not a
// function" on older engines.
function polyfillGetOrInsert(proto: {
  get(key: unknown): unknown;
  has(key: unknown): boolean;
  set(key: unknown, value: unknown): unknown;
  getOrInsert?: unknown;
  getOrInsertComputed?: unknown;
}) {
  if (typeof proto.getOrInsert !== "function") {
    proto.getOrInsert = function (this: typeof proto, key: unknown, value: unknown) {
      if (!this.has(key)) this.set(key, value);
      return this.get(key);
    };
  }
  if (typeof proto.getOrInsertComputed !== "function") {
    proto.getOrInsertComputed = function (
      this: typeof proto,
      key: unknown,
      compute: (k: unknown) => unknown
    ) {
      if (!this.has(key)) this.set(key, compute(key));
      return this.get(key);
    };
  }
}
// pdfjs-dist is ~122 KB gz — a static `import * as pdfjs` here dragged it into
// the First Load of every page that merely *references* a ceremony component
// (~40% of the review page's bundle), defeating this file's stated laziness.
// The library now loads on the first actual render call; the polyfill and the
// worker wiring run once inside that same async path.
type PdfjsModule = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= (async () => {
    polyfillGetOrInsert(Map.prototype as never);
    polyfillGetOrInsert(WeakMap.prototype as never);
    const pdfjs = await import("pdfjs-dist");
    // The worker is served from our own origin by /api/esign/pdf-worker (which
    // streams the file out of node_modules). Bundling the ESM worker directly
    // fights Next's serverExternalPackages handling of pdfjs-dist; a
    // same-origin route sidesteps it and still works offline (no CDN).
    pdfjs.GlobalWorkerOptions.workerSrc = "/api/esign/pdf-worker";
    return pdfjs;
  })();
  return pdfjsPromise;
}

export interface RenderedPage {
  /** Rendered bitmap as a data URL, ready for an <img> backdrop. */
  dataUrl: string;
  /** The page's intrinsic size in PDF points (for placement math). */
  widthPt: number;
  heightPt: number;
  /** Rendered bitmap pixel size — oversampled past the on-screen CSS width (see
   *  renderFirstPage). Only the ratio is consumed (for the box aspect), so the
   *  oversample never shifts layout. */
  widthPx: number;
  heightPx: number;
}

/** Raster width is capped here so a big/hi-DPI page can't blow up the canvas or
 *  the base64 data URL held in state. */
const RASTER_CAP_PX = 2400;

/**
 * Render the first page of a packet to a bitmap. `cssWidthPx` is the width the
 * page is *displayed* at; the bitmap itself is drawn at `oversample`× that
 * (times the device pixel ratio, capped) so the signing surface stays crisp
 * when zoomed in rather than blurring an under-sampled image.
 */
export async function renderFirstPage(
  data: ArrayBuffer,
  cssWidthPx = 800,
  oversample = 2
): Promise<RenderedPage> {
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
  const doc = await loadingTask.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    const rasterWidth = Math.min(RASTER_CAP_PX, Math.round(cssWidthPx * oversample * dpr));
    const scale = rasterWidth / base.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d")!;
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return {
      dataUrl: canvas.toDataURL("image/png"),
      widthPt: base.width,
      heightPt: base.height,
      widthPx: canvas.width,
      heightPx: canvas.height,
    };
  } finally {
    await loadingTask.destroy();
  }
}
