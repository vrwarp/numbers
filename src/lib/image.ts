import sharp from "sharp";
import { IMAGE_TARGET_BYTES } from "./config";

export interface CompressedImage {
  data: Buffer;
  mimeType: "image/webp";
}

/** WebP encode settings shared by the receipt pipeline: quality 10 at effort 4
 *  compresses documents far harder than JPEG at similar legibility; the ladder
 *  steps down for pathological inputs (sharp's quality floor is 1, not 0). */
export const WEBP_QUALITY_LADDER = [10, 5, 1];
export const WEBP_EFFORT = 4;

/**
 * Compress a receipt photo to roughly IMAGE_TARGET_BYTES (~100 KB).
 *
 * Strategy: normalize EXIF rotation, cap the long edge at 1600px (plenty for
 * both human review and LLM OCR), then walk WebP quality down until the
 * output fits the budget. Receipts are high-contrast documents, so even
 * these low nominal qualities stay perfectly legible.
 */
export async function compressReceiptImage(input: Buffer): Promise<CompressedImage> {
  const base = sharp(input, { failOn: "truncated" }).rotate().resize({
    width: 1600,
    height: 1600,
    fit: "inside",
    withoutEnlargement: true,
  });

  let best: Buffer | null = null;
  for (const quality of WEBP_QUALITY_LADDER) {
    best = await base.clone().webp({ quality, effort: WEBP_EFFORT }).toBuffer();
    if (best.length <= IMAGE_TARGET_BYTES) break;
  }

  // Still too big (rare: huge, noisy photos) — shrink dimensions as well.
  if (best && best.length > IMAGE_TARGET_BYTES) {
    best = await sharp(best)
      .resize({ width: 1100, height: 1100, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 1, effort: WEBP_EFFORT })
      .toBuffer();
  }

  if (!best) throw new Error("Image compression produced no output");
  return { data: best, mimeType: "image/webp" };
}

export function isSupportedUpload(mimeType: string): boolean {
  return mimeType === "application/pdf" || mimeType.startsWith("image/");
}

/** Fractions (0..1) of the ROTATED image — resolution-independent so the client
 *  never needs to know the stored pixel dimensions. */
export interface ReceiptCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ReceiptTransform {
  rotate: 0 | 90 | 180 | 270;
  crop?: ReceiptCrop;
}

/** Raised for crop regions a human plausibly drew but that are unusable (→ 400, not 500). */
export class ImageTransformError extends Error {}

const MIN_CROP_PX = 50;

/**
 * Rotate and/or crop a stored receipt image. Rotation is applied first, so the
 * crop fractions refer to the rotated frame — exactly what the user saw when
 * drawing the box. The result goes back through the standard compression
 * ladder to stay within the ~100 KB budget.
 */
export async function transformReceiptImage(
  input: Buffer,
  transform: ReceiptTransform
): Promise<CompressedImage> {
  // autoOrient first: the input may be a pristine upload whose EXIF Orientation
  // an explicit rotate(angle) would otherwise ignore — the fractions were drawn
  // on the oriented image the browser showed.
  // Lossless PNG intermediates: the only lossy re-encode is the final ladder.
  let working = await sharp(input, { failOn: "truncated" })
    .autoOrient()
    .rotate(transform.rotate)
    .png()
    .toBuffer();

  if (transform.crop) {
    const { width = 0, height = 0 } = await sharp(working).metadata();
    const left = Math.min(Math.max(0, Math.round(transform.crop.left * width)), width - 1);
    const top = Math.min(Math.max(0, Math.round(transform.crop.top * height)), height - 1);
    const cropWidth = Math.min(Math.round(transform.crop.width * width), width - left);
    const cropHeight = Math.min(Math.round(transform.crop.height * height), height - top);
    if (cropWidth < MIN_CROP_PX || cropHeight < MIN_CROP_PX) {
      throw new ImageTransformError("Crop region is too small to stay legible");
    }
    working = await sharp(working)
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .png()
      .toBuffer();
  }

  return compressReceiptImage(working);
}
