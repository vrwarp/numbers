import sharp from "sharp";
import { IMAGE_TARGET_BYTES } from "./config";

export interface CompressedImage {
  data: Buffer;
  mimeType: "image/jpeg";
}

/**
 * Compress a receipt photo to roughly IMAGE_TARGET_BYTES (~100 KB).
 *
 * Strategy: normalize EXIF rotation, cap the long edge at 1600px (plenty for
 * both human review and LLM OCR), then walk JPEG quality down until the
 * output fits the budget. Receipts are high-contrast documents, so even
 * quality 40 stays perfectly legible.
 */
export async function compressReceiptImage(input: Buffer): Promise<CompressedImage> {
  const base = sharp(input, { failOn: "truncated" }).rotate().resize({
    width: 1600,
    height: 1600,
    fit: "inside",
    withoutEnlargement: true,
  });

  let best: Buffer | null = null;
  for (const quality of [80, 65, 50, 40]) {
    best = await base.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (best.length <= IMAGE_TARGET_BYTES) break;
  }

  // Still too big (rare: huge, noisy photos) — shrink dimensions as well.
  if (best && best.length > IMAGE_TARGET_BYTES) {
    best = await sharp(best)
      .resize({ width: 1100, height: 1100, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 40, mozjpeg: true })
      .toBuffer();
  }

  if (!best) throw new Error("Image compression produced no output");
  return { data: best, mimeType: "image/jpeg" };
}

export function isSupportedUpload(mimeType: string): boolean {
  return mimeType === "application/pdf" || mimeType.startsWith("image/");
}
