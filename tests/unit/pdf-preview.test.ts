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
  it("renders a single-page PDF to a 1000px-wide JPEG", async () => {
    const jpeg = await renderPdfToPreviewJpeg(await makePdf(1, 300, 400));
    // JPEG magic bytes.
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1000);
    // 300×400 page scaled to 1000 wide → ~1333 tall.
    expect(meta.height).toBeGreaterThanOrEqual(1330);
    expect(meta.height).toBeLessThanOrEqual(1336);
  });

  it("stacks multiple pages into one tall strip", async () => {
    const one = await sharp(await renderPdfToPreviewJpeg(await makePdf(1))).metadata();
    const three = await sharp(await renderPdfToPreviewJpeg(await makePdf(3))).metadata();
    expect(three.width).toBe(1000);
    // Three identical pages → roughly triple the height (allow rounding).
    expect(three.height!).toBeGreaterThanOrEqual(one.height! * 3 - 3);
    expect(three.height!).toBeLessThanOrEqual(one.height! * 3 + 3);
  });

  it("caps the preview at MAX_PREVIEW_PAGES", async () => {
    const one = await sharp(await renderPdfToPreviewJpeg(await makePdf(1))).metadata();
    const many = await sharp(
      await renderPdfToPreviewJpeg(await makePdf(MAX_PREVIEW_PAGES + 5)),
    ).metadata();
    // Height reflects the cap, not the full page count.
    expect(many.height!).toBeLessThanOrEqual(one.height! * MAX_PREVIEW_PAGES + 3);
    expect(many.height!).toBeGreaterThanOrEqual(one.height! * MAX_PREVIEW_PAGES - 3);
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(renderPdfToPreviewJpeg(Buffer.from("not a pdf"))).rejects.toBeTruthy();
  });
});
