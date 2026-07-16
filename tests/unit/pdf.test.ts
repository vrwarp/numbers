import { beforeAll, describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";
import zlib from "zlib";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import {
  fittingFontSize,
  generateClaimPdf,
  splitAddress,
  toEncodableText,
  wrapTextMeasured,
  type PdfLineItem,
} from "@/lib/pdf/generate";

let templateBytes: Uint8Array;

beforeAll(async () => {
  templateBytes = new Uint8Array(
    await fs.readFile(path.join(process.cwd(), "assets", "cfcc-form-template.pdf"))
  );
});

const items = (n: number): PdfLineItem[] =>
  Array.from({ length: n }, (_, i) => ({
    description: `Item ${i + 1}`,
    amountCents: 1000 + i,
    ministry: "General Fund",
  }));

async function jpegReceipt(): Promise<Buffer> {
  return sharp({
    create: { width: 600, height: 900, channels: 3, background: { r: 255, g: 255, b: 250 } },
  })
    .jpeg()
    .toBuffer();
}

async function webpReceipt(): Promise<Buffer> {
  return sharp({
    create: { width: 600, height: 900, channels: 3, background: { r: 255, g: 255, b: 250 } },
  })
    .webp({ quality: 10, effort: 4 })
    .toBuffer();
}

async function pdfReceipt(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

/** Inflate every flate-compressed stream so drawn/flattened text becomes searchable. */
function pdfVisibleText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const raw = buf.toString("latin1");
  let out = raw;
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end === -1) continue;
    try {
      out += zlib.inflateSync(buf.subarray(start, end)).toString("latin1");
    } catch {
      // not a flate stream (e.g. an embedded image) — skip
    }
  }
  // pdf-lib writes drawn text as hex strings (<4772...>); decode them.
  let decoded = "";
  for (const m of out.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
    const hex = m[1].replace(/\s/g, "");
    for (let i = 0; i + 1 < hex.length; i += 2) {
      decoded += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    decoded += "\n";
  }
  return out + decoded;
}

const baseInput = () => ({
  requesterName: "Grace Chen",
  requesterAddress: "123 Main St, San Jose, CA 95110",
  dateString: "07/03/2026",
  templateBytes,
});

describe("generateClaimPdf (official CFCC AcroForm template)", () => {
  it("produces one filled form page + one page per image receipt (label carries the note)", async () => {
    const bytes = await generateClaimPdf({
      ...baseInput(),
      items: items(3),
      receipts: [
        {
          data: await jpegReceipt(),
          mimeType: "image/jpeg",
          originalName: "costco.jpg",
          note: "VBS craft supplies",
        },
      ],
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    const text = pdfVisibleText(bytes);
    expect(text).toContain("costco.jpg");
    expect(text).toContain("VBS craft supplies");
  });

  it("fits up to 13 items on a single form page", async () => {
    const bytes = await generateClaimPdf({ ...baseInput(), items: items(13), receipts: [] });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it("paginates 15 line items onto two form pages, receipts at the very end", async () => {
    const bytes = await generateClaimPdf({
      ...baseInput(),
      items: items(15),
      receipts: [{ data: await jpegReceipt(), mimeType: "image/jpeg", originalName: "big.jpg" }],
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3); // 2 form pages + 1 receipt

    const text = pdfVisibleText(bytes);
    expect(text).toContain("(continued)"); // page 1 carries the total forward
    expect(text).toContain("Page 1 of 2");
    expect(text).toContain("Page 2 of 2");
  });

  it("appends WebP receipt images (transcoded — pdf-lib embeds only PNG/JPEG)", async () => {
    const bytes = await generateClaimPdf({
      ...baseInput(),
      items: items(1),
      receipts: [{ data: await webpReceipt(), mimeType: "image/webp", originalName: "scan.webp" }],
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2); // 1 form page + 1 receipt page
    expect(pdfVisibleText(bytes)).toContain("scan.webp");
  });

  it("merges multi-page PDF receipts at the end", async () => {
    const bytes = await generateClaimPdf({
      ...baseInput(),
      items: items(2),
      receipts: [
        { data: await pdfReceipt(2), mimeType: "application/pdf", originalName: "invoice.pdf" },
        { data: await jpegReceipt(), mimeType: "image/jpeg", originalName: "photo.jpg" },
      ],
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(4); // 1 form + 2 pdf pages + 1 image page
  });

  it("stamps name, address, date, line items and the grand total into the form fields", async () => {
    const bytes = await generateClaimPdf({
      ...baseInput(),
      items: [
        {
          description: "Costco Wholesale 06/21 — paper towels, snacks",
          amountCents: 10210,
          ministry: "Facilities",
        },
        { description: "Amazon 06/04 — rulers, duct tape", amountCents: 3095, ministry: "Facilities" },
      ],
      receipts: [],
    });
    const text = pdfVisibleText(bytes);
    expect(text).toContain("Grace Chen"); // payable-to + requestor name
    expect(text).toContain("123 Main St,");
    expect(text).toContain("07/03/2026");
    expect(text).toContain("Costco Wholesale 06/21");
    expect(text).toContain("Facilities");
    expect(text).toContain("102.10");
    expect(text).toContain("133.05"); // grand total 102.10 + 30.95

    // Flattening must remove the interactive fields.
    const doc = await PDFDocument.load(bytes);
    expect(doc.getForm().getFields()).toHaveLength(0);
  });

  it("handles refund-heavy claims with a negative grand total", async () => {
    const bytes = await generateClaimPdf({
      ...baseInput(),
      items: [
        { description: "Costco 06/28 — paper towel (refunded)", amountCents: -2798, ministry: "General Fund" },
        { description: "Small item", amountCents: 500, ministry: "General Fund" },
      ],
      receipts: [],
    });
    const text = pdfVisibleText(bytes);
    expect(text).toContain("-27.98");
    expect(text).toContain("-22.98"); // grand total
  });

  it("truncates over-long receipt file names in the appended-page label", async () => {
    const longName = `${"a-very-long-receipt-file-name".repeat(10)}.jpg`; // ~294 chars
    const bytes = await generateClaimPdf({
      ...baseInput(),
      items: items(1),
      receipts: [{ data: await jpegReceipt(), mimeType: "image/jpeg", originalName: longName }],
    });
    const text = pdfVisibleText(bytes);
    expect(text).toContain("Receipt 1 of 1");
    expect(text).not.toContain(longName); // clipped to the page width, not drawn off-page
  });

  it("refuses to run without the template", async () => {
    await expect(
      generateClaimPdf({ ...baseInput(), templateBytes: new Uint8Array(), items: items(1), receipts: [] })
    ).rejects.toThrow(/template/i);
  });

  it("stamps the QR self-link on EVERY form page when selfLinkUrl is set", async () => {
    const bytes = await generateClaimPdf({
      ...baseInput(),
      items: items(15), // two form pages
      receipts: [],
      selfLinkUrl: "https://numbers.example.org/c/AbC123xyz_-AbC123xyz_-AbC123xyz_",
    });
    const text = pdfVisibleText(bytes);
    // The stamp redraws the note box narrower to make room for the QR; the
    // redrawn note text is pdf-lib-drawn (hex-searchable), unlike the
    // template's own subset-encoded original — so it marks exactly the
    // pages that got the stamp.
    expect(text.match(/pastor\/deacon\./g)).toHaveLength(2);
    expect(text.match(/turn-around time is 1-2 weeks\./g)).toHaveLength(2);
  });

  it("omits the stamp (and leaves the note box alone) without selfLinkUrl", async () => {
    const bytes = await generateClaimPdf({ ...baseInput(), items: items(1), receipts: [] });
    expect(pdfVisibleText(bytes)).not.toContain("pastor/deacon.");
  });
});

describe("qrMatrix (QR stamp geometry)", () => {
  it("emits a square matrix with the three finder patterns", async () => {
    const { qrMatrix } = await import("@/lib/pdf/qr");
    const m = qrMatrix("https://numbers.example.org/c/AbC123xyz_-AbC123xyz_-AbC123xyz_");
    const n = m.length;
    expect(n).toBeGreaterThanOrEqual(21); // ≥ version 1
    expect(n % 2).toBe(1); // QR sizes are odd (4v+17)
    for (const row of m) expect(row).toHaveLength(n);
    // Finder pattern corners (top-left, top-right, bottom-left) are dark.
    for (const [r, c] of [[0, 0], [0, n - 1], [n - 1, 0]] as const) {
      expect(m[r][c]).toBe(true);
    }
  });
});

describe("fittingFontSize (description column auto-shrink)", () => {
  // Real geometry of "Description QuantityRow{n}" on the CFCC template
  // (after scripts/shrink-quantity-column.mjs widened it), minus pdf-lib's
  // 1pt padding per side (the fields have no border).
  const DESC_BOUNDS = { width: 191.68, height: 15.76 };

  async function helvetica() {
    const doc = await PDFDocument.create();
    const { StandardFonts } = await import("pdf-lib");
    return doc.embedFont(StandardFonts.Helvetica);
  }

  it("keeps short descriptions at the 8pt maximum", async () => {
    const font = await helvetica();
    expect(fittingFontSize("Costco 06/21 — snacks", font, DESC_BOUNDS, 8)).toBe(8);
  });

  it("shrinks a wide ALL-CAPS description that a character-count cutoff missed", async () => {
    // 49 chars — under the old >55 threshold — but too wide for one 8pt line,
    // and two 8pt lines overflow the row: the second line was clipped.
    const font = await helvetica();
    const text = "THE HOME DEPOT 06/16 — HEAVY DUTY LG BOX 26X16X15";
    const size = fittingFontSize(text, font, DESC_BOUNDS, 8);
    expect(size).toBeLessThan(8);
    // Two wrapped lines at the chosen size must fit inside the row height.
    expect(font.heightAtSize(size) * 1.2 * 2).toBeLessThanOrEqual(DESC_BOUNDS.height);
  });

  it("never returns below pdf-lib's 4pt floor even for absurd input", async () => {
    const font = await helvetica();
    expect(fittingFontSize("WORD ".repeat(400).trim(), font, DESC_BOUNDS, 8)).toBe(4);
  });

  it("shrinks single-line fields (ministry column) on width alone — no wrapping", async () => {
    // "For Ministry  EventRow{n}" geometry: 154.32 × 17.76 minus 1pt padding.
    const bounds = { width: 152.32, height: 15.76 };
    const font = await helvetica();
    expect(fittingFontSize("Children's Ministry", font, bounds, 8, false)).toBe(8);
    const long = "Children's Ministry / Summer Camp 2026 Outreach";
    const size = fittingFontSize(long, font, bounds, 8, false);
    expect(size).toBeLessThan(8);
    expect(font.widthOfTextAtSize(long, size)).toBeLessThanOrEqual(bounds.width);
  });
});

describe("toEncodableText (per-font sanitizing net)", () => {
  async function helvetica() {
    const doc = await PDFDocument.create();
    const { StandardFonts } = await import("pdf-lib");
    return doc.embedFont(StandardFonts.Helvetica);
  }
  async function cjk() {
    const doc = await PDFDocument.create();
    const { embedCjkFont } = await import("@/lib/pdf/fonts");
    return embedCjkFont(doc);
  }

  it("passes plain descriptions through untouched, incl. em-dash and accents", async () => {
    const font = await helvetica();
    const s = "Café Récolte 06/21 — crème brûlée (refunded)";
    expect(toEncodableText(s, font)).toBe(s);
  });

  it("flags CJK against Helvetica — the signal generate.ts uses to switch fonts", async () => {
    const font = await helvetica();
    expect(toEncodableText("大華超市 99 Ranch Market 06/28 — 燒臘, rice", font)).toBe(
      "… 99 Ranch Market 06/28 — …, rice"
    );
    expect(toEncodableText("中文事工 Chinese Ministry", font)).toBe("… Chinese Ministry");
  });

  it("passes Traditional and Simplified Chinese through the bundled CJK face", async () => {
    const font = await cjk();
    for (const s of [
      "大華超市 99 Ranch Market 06/28 — 燒臘, rice, 青菜",
      "中文事工 — 退修會",
      "简体测试：办公用品 华人教会",
      "陳恩典 Grace Chen",
    ]) {
      expect(toEncodableText(s, font)).toBe(s);
    }
  });

  it("still collapses characters even the CJK face lacks (emoji) to an ellipsis", async () => {
    const font = await cjk();
    expect(toEncodableText("VBS 手工材料 📷 receipts", font)).toBe("VBS 手工材料 … receipts");
  });

  it("normalizes exotic whitespace so the field never blanks or 500s", async () => {
    // A value whose only non-WinAnsi char is the ideographic space U+3000 (a
    // Chinese IME emits it) used to slip past the encodability check, then
    // helv.widthOfTextAtSize threw 'WinAnsi cannot encode "\\u3000"'.
    const helv = await helvetica();
    const out = toEncodableText("receipt　scan.jpg", helv);
    // The result must be fully Helvetica-encodable (no throw when measured).
    expect(() => helv.widthOfTextAtSize(out, 8)).not.toThrow();
    expect(out).not.toMatch(/[\u3000\u00a0\u2028\u2029]/);
    expect(out).toContain("scan.jpg");
  });

  it("generateClaimPdf survives an ideographic-space filename in a receipt note", async () => {
    const png = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .png()
      .toBuffer();
    const bytes = await generateClaimPdf({
      ...baseInput(),
      items: items(1),
      receipts: [{ data: png, mimeType: "image/png", originalName: "receipt　scan.png" }],
    });
    expect(bytes.length).toBeGreaterThan(1000);
  });
});

describe("wrapTextMeasured (pre-wrapping for unspaced CJK runs)", () => {
  async function cjk() {
    const doc = await PDFDocument.create();
    const { embedCjkFont } = await import("@/lib/pdf/fonts");
    return embedCjkFont(doc);
  }

  it("breaks an unspaced CJK run at measured width; every line fits", async () => {
    const font = await cjk();
    const text = "青菜豆腐燒臘叉燒飯外帶餐盒紙巾雞蛋牛奶麵包"; // no break points for pdf-lib
    const width = 80;
    const wrapped = wrapTextMeasured(text, font, width, 8);
    const lines = wrapped.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(font.widthOfTextAtSize(line, 8)).toBeLessThanOrEqual(width);
    }
    expect(lines.join("")).toBe(text); // nothing lost
  });

  it("keeps whitespace word-wrapping for Latin text (words stay whole)", async () => {
    const font = await cjk();
    const wrapped = wrapTextMeasured("folding table and paper towels", font, 60, 8);
    for (const line of wrapped.split("\n")) {
      expect(font.widthOfTextAtSize(line, 8)).toBeLessThanOrEqual(60);
    }
    expect(wrapped.replace(/\n/g, " ")).toBe("folding table and paper towels");
  });
});

describe("generateClaimPdf with Chinese content (the P0 bug fix)", () => {
  it("renders CJK descriptions/ministries/names instead of stripping them to ellipses", async () => {
    const bytes = await generateClaimPdf({
      ...baseInput(),
      requesterName: "陳恩典 Grace Chen",
      items: [
        {
          description: "大華超市 06/28 — 燒臘, 青菜豆腐外帶餐盒紙巾雞蛋牛奶, rice",
          amountCents: 10210,
          ministry: "450 Joshua Fellowship - Mandarin",
        },
        { description: "简体测试：办公用品", amountCents: 2500, ministry: "中文事工" },
      ],
      receipts: [
        {
          data: await jpegReceipt(),
          mimeType: "image/jpeg",
          originalName: "ranch99.jpg",
          note: "退修會食物",
        },
      ],
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);

    const text = pdfVisibleText(bytes);
    // The subset CJK face is embedded (BaseFont carries the Noto name)…
    expect(text).toContain("NotoSansCJK");
    // …and its ToUnicode CMap maps glyphs back to the exact source characters
    // (CID hex streams aren't decodable by pdfVisibleText, so assert via CMap).
    for (const ch of ["大", "燒", "陳", "简", "退"]) {
      const unicodeHex = ch.codePointAt(0)!.toString(16).padStart(4, "0");
      expect(text).toMatch(new RegExp(`<[0-9a-fA-F]{4}> <${unicodeHex}>`, "i"));
    }
    // Fields whose values stay WinAnsi still render through Helvetica and
    // remain byte-visible (a CJK-bearing field is CID-encoded wholesale).
    expect(text).toContain("102.10");
    expect(text).toContain("07/03/2026");
    expect(text).toContain("123 Main St");
    // A subset, not the whole 16 MB font, ships in the packet.
    expect(bytes.length).toBeLessThan(1_500_000);
  });

  it("keeps pure-Latin claims on Helvetica only (no CJK face embedded)", async () => {
    const bytes = await generateClaimPdf({ ...baseInput(), items: items(2), receipts: [] });
    expect(pdfVisibleText(bytes)).not.toContain("NotoSansCJK");
  });
});

describe("splitAddress", () => {
  it("keeps short addresses on one line", () => {
    expect(splitAddress("123 Main St, San Jose CA")).toEqual(["123 Main St, San Jose CA", ""]);
  });

  it("breaks long addresses at the comma nearest the middle", () => {
    const [l1, l2] = splitAddress("22416 Meekland Avenue Apt 12, Hayward, CA 94541, United States");
    expect(l1.length).toBeGreaterThan(0);
    expect(l2.length).toBeGreaterThan(0);
    expect(`${l1} ${l2}`.replace(/\s+/g, " ")).toContain("Hayward");
  });

  it("falls back to a space break when there are no commas", () => {
    const [l1, l2] = splitAddress("22416 Meekland Avenue Apartment 12 Hayward California 94541");
    expect(l1.length).toBeLessThanOrEqual(45);
    expect(l2.length).toBeGreaterThan(0);
  });
});
