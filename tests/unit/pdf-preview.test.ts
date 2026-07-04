import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { renderPdfPreviewPages, MAX_PREVIEW_PAGES } from "@/lib/pdf/preview";

/** A PDF with `n` pages, each `w`×`h` points. */
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

/** Count of dark (inked) pixels in an image. */
async function ink(webp: Buffer): Promise<number> {
  const { data } = await sharp(webp).greyscale().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < data.length; i++) if (data[i] < 160) n++;
  return n;
}

describe("renderPdfPreviewPages", () => {
  it("renders one WebP per page at high density, preserving aspect ratio", async () => {
    const { pages, omitted } = await renderPdfPreviewPages(await makePdf(2, 300, 400));
    expect(pages).toHaveLength(2);
    expect(omitted).toBe(0);
    for (const page of pages) {
      const meta = await sharp(page).metadata();
      expect(meta.format).toBe("webp");
      // ~300 DPI: a 300pt-wide page → 300/72*300 = 1250px.
      expect(meta.width!).toBeGreaterThanOrEqual(1200);
      expect(meta.height! / meta.width!).toBeCloseTo(400 / 300, 1);
    }
  });

  it("renders a Letter page at full ~300 DPI (2550px wide)", async () => {
    const { pages } = await renderPdfPreviewPages(await makePdf(1, 612, 792));
    const meta = await sharp(pages[0]).metadata();
    expect(meta.width!).toBeGreaterThanOrEqual(2500);
  });

  it("keeps each page within roughly the 100 KB budget", async () => {
    const { pages } = await renderPdfPreviewPages(await makePdfWithTextPerPage(3));
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(115 * 1024);
    }
  });

  it("renders content on every page, not just the last", async () => {
    // Regression: pdfjs clears the target canvas per render(); each page must
    // come back with its own content.
    const { pages } = await renderPdfPreviewPages(await makePdfWithTextPerPage(3));
    for (const page of pages) {
      expect(await ink(page)).toBeGreaterThan(300);
    }
  });

  it("caps at MAX_PREVIEW_PAGES and reports the omitted count", async () => {
    const { pages, omitted } = await renderPdfPreviewPages(await makePdf(MAX_PREVIEW_PAGES + 5));
    expect(pages).toHaveLength(MAX_PREVIEW_PAGES);
    expect(omitted).toBe(5);
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(renderPdfPreviewPages(Buffer.from("not a pdf"))).rejects.toBeTruthy();
  });
});
