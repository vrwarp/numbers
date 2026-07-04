import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { renderPdfToPreviewJpeg, MAX_PREVIEW_PAGES } from "@/lib/pdf/preview";

/** A PDF with `n` pages, each `w`×`h` points, so height stacking is predictable. */
async function makePdf(n: number, w = 300, h = 400): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([w, h]);
  return Buffer.from(await doc.save());
}

/** A PDF whose every page carries text, so we can assert each page renders. */
async function makePdfWithTextPerPage(n: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < n; i++) {
    doc.addPage([300, 400]).drawText(`PAGE ${i + 1}`, { x: 30, y: 200, size: 36, font });
  }
  return Buffer.from(await doc.save());
}

/** Count of dark (inked) pixels in a horizontal band [fromFrac, toFrac) of the image. */
async function inkInBand(jpeg: Buffer, fromFrac: number, toFrac: number): Promise<number> {
  const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
  const from = Math.floor(info.height * fromFrac) * info.width;
  const to = Math.floor(info.height * toFrac) * info.width;
  let ink = 0;
  for (let i = from; i < to; i++) if (data[i] < 160) ink++;
  return ink;
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

  it("renders content on every page, not just the last", async () => {
    // Regression: pdfjs clears the target canvas per render(), so a shared-canvas
    // approach left only the final page and blanked the rest.
    const jpeg = await renderPdfToPreviewJpeg(await makePdfWithTextPerPage(3));
    // Each third of the strip is one page; all must carry ink.
    expect(await inkInBand(jpeg, 0, 1 / 3)).toBeGreaterThan(300);
    expect(await inkInBand(jpeg, 1 / 3, 2 / 3)).toBeGreaterThan(300);
    expect(await inkInBand(jpeg, 2 / 3, 1)).toBeGreaterThan(300);
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
