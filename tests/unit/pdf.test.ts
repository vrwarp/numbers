import { beforeAll, describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";
import zlib from "zlib";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { generateClaimPdf, splitAddress, type PdfLineItem } from "@/lib/pdf/generate";

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

  it("refuses to run without the template", async () => {
    await expect(
      generateClaimPdf({ ...baseInput(), templateBytes: new Uint8Array(), items: items(1), receipts: [] })
    ).rejects.toThrow(/template/i);
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
