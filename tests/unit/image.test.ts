import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { compressReceiptImage, isSupportedUpload } from "@/lib/image";
import { IMAGE_TARGET_BYTES } from "@/lib/config";

/** Build a noisy fake "photo" that compresses poorly, like a real camera shot. */
async function noisyPhoto(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  let seed = 42;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = seed % 256;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

describe("compressReceiptImage", () => {
  it("compresses a large photo to roughly the 100 KB target", async () => {
    const input = await noisyPhoto(2400, 3200);
    expect(input.length).toBeGreaterThan(IMAGE_TARGET_BYTES * 3);
    const out = await compressReceiptImage(input);
    expect(out.mimeType).toBe("image/jpeg");
    // "approximately 100kb" — allow 15% headroom over the target.
    expect(out.data.length).toBeLessThanOrEqual(IMAGE_TARGET_BYTES * 1.15);
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1600);
  }, 30000);

  it("converts small PNG uploads to JPEG without inflating them", async () => {
    const png = await sharp({
      create: { width: 400, height: 600, channels: 3, background: { r: 250, g: 250, b: 245 } },
    })
      .png()
      .toBuffer();
    const out = await compressReceiptImage(png);
    expect(out.mimeType).toBe("image/jpeg");
    expect(out.data.length).toBeLessThanOrEqual(IMAGE_TARGET_BYTES);
    const meta = await sharp(out.data).metadata();
    // Small images must not be upscaled.
    expect(meta.width).toBe(400);
  });

  it("rejects non-image garbage", async () => {
    await expect(compressReceiptImage(Buffer.from("not an image"))).rejects.toThrow();
  });
});

describe("isSupportedUpload", () => {
  it("accepts images and PDFs, rejects everything else", () => {
    expect(isSupportedUpload("image/jpeg")).toBe(true);
    expect(isSupportedUpload("image/png")).toBe(true);
    expect(isSupportedUpload("image/heic")).toBe(true);
    expect(isSupportedUpload("application/pdf")).toBe(true);
    expect(isSupportedUpload("text/html")).toBe(false);
    expect(isSupportedUpload("application/zip")).toBe(false);
  });
});
