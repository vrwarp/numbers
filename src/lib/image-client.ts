/**
 * Client-side image helpers for the pre-upload prepare step. The full-resolution
 * photo never leaves the device: rotate/crop render on a canvas at the source's
 * native resolution, and the upload payload is downscaled to the same 1600px cap
 * the server's compression ladder would apply anyway. DOM-only — no node imports
 * (the sharp pipeline lives in src/lib/image.ts, server only).
 */

export interface ClientCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ClientTransform {
  rotate: 0 | 90 | 180 | 270;
  crop?: ClientCrop;
}

/** Mirrors the server cap in compressReceiptImage — uploading finer detail is wasted bytes. */
export const UPLOAD_MAX_EDGE = 1600;
// Native-resolution intermediate between edits: near-lossless so a re-edit
// before upload doesn't compound quality loss.
const EDIT_JPEG_QUALITY = 0.92;
const UPLOAD_JPEG_QUALITY = 0.9;

/** Decode via <img> so the browser applies EXIF orientation — naturalWidth/Height
 *  and drawImage then both use the oriented pixels the user actually sees. */
function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode the image in this browser"));
    };
    img.src = url;
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Could not encode the edited image"))),
      "image/jpeg",
      quality
    )
  );
}

/**
 * Rotate/crop `source` at its native resolution. The crop fractions refer to the
 * ROTATED frame — the same contract as the server's transformReceiptImage, so the
 * box the user drew maps 1:1. Throws when the browser cannot decode the image.
 */
export async function renderTransformedImage(
  source: Blob,
  transform: ClientTransform
): Promise<Blob> {
  const img = await loadImage(source);
  const rotatedW = transform.rotate % 180 === 0 ? img.naturalWidth : img.naturalHeight;
  const rotatedH = transform.rotate % 180 === 0 ? img.naturalHeight : img.naturalWidth;
  const crop = transform.crop ?? { left: 0, top: 0, width: 1, height: 1 };
  const left = Math.min(Math.max(0, Math.round(crop.left * rotatedW)), rotatedW - 1);
  const top = Math.min(Math.max(0, Math.round(crop.top * rotatedH)), rotatedH - 1);
  const width = Math.max(1, Math.min(Math.round(crop.width * rotatedW), rotatedW - left));
  const height = Math.max(1, Math.min(Math.round(crop.height * rotatedH), rotatedH - top));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable");
  // Transforms apply to drawn points in reverse call order: rotate into the
  // rotated frame first, then shift the crop region to the canvas origin.
  ctx.translate(-left, -top);
  if (transform.rotate === 90) ctx.translate(rotatedW, 0);
  else if (transform.rotate === 180) ctx.translate(rotatedW, rotatedH);
  else if (transform.rotate === 270) ctx.translate(0, rotatedH);
  ctx.rotate((transform.rotate * Math.PI) / 180);
  ctx.drawImage(img, 0, 0);
  return canvasToJpeg(canvas, EDIT_JPEG_QUALITY);
}

/**
 * Build the upload payload for a pending image: downscale to UPLOAD_MAX_EDGE so
 * the original megapixels stay on the device. Falls back to the untouched file
 * when the browser can't decode it (e.g. HEIC on some platforms) — the server's
 * sharp pipeline gets the same chance it always had.
 */
export async function prepareImageUpload(
  file: File,
  edited: Blob | null
): Promise<File> {
  const source = edited ?? file;
  try {
    const img = await loadImage(source);
    const scale = Math.min(1, UPLOAD_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1) {
      return edited ? new File([edited], file.name, { type: "image/jpeg" }) : file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToJpeg(canvas, UPLOAD_JPEG_QUALITY);
    return new File([blob], file.name, { type: "image/jpeg" });
  } catch {
    return edited ? new File([edited], file.name, { type: "image/jpeg" }) : file;
  }
}
