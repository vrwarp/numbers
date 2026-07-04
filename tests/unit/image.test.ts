import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { compressReceiptImage, isSupportedUpload, transformReceiptImage } from "@/lib/image";
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
    expect(out.mimeType).toBe("image/webp");
    // "approximately 100kb" — allow 15% headroom over the target.
    expect(out.data.length).toBeLessThanOrEqual(IMAGE_TARGET_BYTES * 1.15);
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1600);
  }, 30000);

  it("converts small PNG uploads to WebP without inflating them", async () => {
    const png = await sharp({
      create: { width: 400, height: 600, channels: 3, background: { r: 250, g: 250, b: 245 } },
    })
      .png()
      .toBuffer();
    const out = await compressReceiptImage(png);
    expect(out.mimeType).toBe("image/webp");
    expect(out.data.length).toBeLessThanOrEqual(IMAGE_TARGET_BYTES);
    const meta = await sharp(out.data).metadata();
    // Small images must not be upscaled.
    expect(meta.width).toBe(400);
  });

  it("rejects non-image garbage", async () => {
    await expect(compressReceiptImage(Buffer.from("not an image"))).rejects.toThrow();
  });
});

/** Left half red, right half blue — lets tests see WHERE a crop landed. */
async function twoTone(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (x < width / 2) raw[i] = 220; // red
      else raw[i + 2] = 220; // blue
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe("transformReceiptImage", () => {
  it("rotates in 90° steps (dimensions swap)", async () => {
    const input = await twoTone(400, 600);
    const out = await transformReceiptImage(input, { rotate: 90 });
    expect(out.mimeType).toBe("image/webp");
    const meta = await sharp(out.data).metadata();
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(400);
  });

  it("crops fractional regions of the image", async () => {
    const input = await twoTone(400, 600);
    const out = await transformReceiptImage(input, {
      rotate: 0,
      crop: { left: 0.25, top: 0.25, width: 0.5, height: 0.5 },
    });
    const meta = await sharp(out.data).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(300);
  });

  it("applies the crop AFTER rotation (fractions refer to the rotated frame)", async () => {
    // 90° clockwise puts the red (left) half on TOP; cropping the top half
    // must therefore return a red image.
    const input = await twoTone(400, 200);
    const out = await transformReceiptImage(input, {
      rotate: 90,
      crop: { left: 0, top: 0, width: 1, height: 0.5 },
    });
    const meta = await sharp(out.data).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(200);
    const stats = await sharp(out.data).stats();
    expect(stats.channels[0].mean).toBeGreaterThan(180); // red
    expect(stats.channels[2].mean).toBeLessThan(60); // no blue
  });

  it("honors EXIF orientation before rotating/cropping (raw uploads)", async () => {
    // Stored 400×200 with orientation 6 ("rotate 90° CW to display") — every
    // viewer shows it as 200×400 with the red (left) half on TOP. The crop
    // fractions were drawn on that displayed frame, so cropping the top half
    // must return a red 200×200 image, not a slice of the un-oriented pixels.
    const oriented = await sharp(await twoTone(400, 200))
      .jpeg({ quality: 95 })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await transformReceiptImage(oriented, {
      rotate: 0,
      crop: { left: 0, top: 0, width: 1, height: 0.5 },
    });
    const meta = await sharp(out.data).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(200);
    const stats = await sharp(out.data).stats();
    expect(stats.channels[0].mean).toBeGreaterThan(180); // red
    expect(stats.channels[2].mean).toBeLessThan(60); // no blue
  });

  it("rejects crop regions too small to stay legible", async () => {
    const input = await twoTone(400, 600);
    await expect(
      transformReceiptImage(input, {
        rotate: 0,
        crop: { left: 0, top: 0, width: 0.05, height: 0.05 },
      })
    ).rejects.toThrow(/too small/i);
  });

  it("keeps the output within the compression budget", async () => {
    const input = await noisyPhoto(1600, 1200);
    const out = await transformReceiptImage(input, { rotate: 180 });
    expect(out.data.length).toBeLessThanOrEqual(IMAGE_TARGET_BYTES * 1.15);
  }, 30000);
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
