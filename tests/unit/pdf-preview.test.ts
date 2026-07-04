import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { renderPdfToPreviewJpeg, MAX_PREVIEW_PAGES } from "@/lib/pdf/preview";

/** A PDF with `n` pages, each `w`×`h` points, so height stacking is predictable. */
async function makePdf(n: number, w = 300, h = 400): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([w, h]);
  return Buffer.from(await doc.save());
}

describe("renderPdfToPreviewJpeg", () => {
  it("renders a single-page PDF to a high-density JPEG preserving aspect ratio", async () => {
    const jpeg = await renderPdfToPreviewJpeg(await makePdf(1, 300, 400));
    // JPEG magic bytes.
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe("jpeg");
    // ~200 DPI: a 300pt-wide page renders well above the old 1000px so small
    // text stays legible; aspect ratio (300:400) is preserved.
    expect(meta.width!).toBeGreaterThanOrEqual(800);
    expect(meta.height! / meta.width!).toBeCloseTo(400 / 300, 1);
  });

  it("stacks multiple pages into one tall strip", async () => {
    const one = await sharp(await renderPdfToPreviewJpeg(await makePdf(1))).metadata();
    const three = await sharp(await renderPdfToPreviewJpeg(await makePdf(3))).metadata();
    expect(three.width).toBe(one.width);
    // Three identical pages → roughly triple the height (allow rounding).
    expect(three.height!).toBeGreaterThanOrEqual(one.height! * 3 - 3);
    expect(three.height!).toBeLessThanOrEqual(one.height! * 3 + 3);
  });

  it("caps at MAX_PREVIEW_PAGES and appends a truncation-notice band", async () => {
    const one = await sharp(await renderPdfToPreviewJpeg(await makePdf(1))).metadata();
    const jpeg = await renderPdfToPreviewJpeg(await makePdf(MAX_PREVIEW_PAGES + 5));
    const many = await sharp(jpeg).metadata();
    const pagesHeight = one.height! * MAX_PREVIEW_PAGES;
    // Only MAX pages are drawn, plus a notice band — so the strip is taller than
    // the capped pages alone but far short of the full 15-page height.
    expect(many.height!).toBeGreaterThan(pagesHeight);
    expect(many.height!).toBeLessThanOrEqual(pagesHeight + 200);
    // The band carries ink (the notice text), not just blank space.
    const band = await sharp(jpeg)
      .extract({ left: 0, top: pagesHeight, width: many.width!, height: many.height! - pagesHeight })
      .greyscale()
      .raw()
      .toBuffer();
    const ink = band.reduce((n, v) => (v < 160 ? n + 1 : n), 0);
    expect(ink).toBeGreaterThan(200);
  });

  it("renders every page when the count is within the cap (no notice)", async () => {
    const one = await sharp(await renderPdfToPreviewJpeg(await makePdf(1))).metadata();
    const full = await sharp(
      await renderPdfToPreviewJpeg(await makePdf(MAX_PREVIEW_PAGES)),
    ).metadata();
    // Exactly MAX pages: all drawn, no notice band appended.
    expect(full.height!).toBeGreaterThanOrEqual(one.height! * MAX_PREVIEW_PAGES - 3);
    expect(full.height!).toBeLessThanOrEqual(one.height! * MAX_PREVIEW_PAGES + 3);
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(renderPdfToPreviewJpeg(Buffer.from("not a pdf"))).rejects.toBeTruthy();
  });
});
