import { beforeAll, describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";
import zlib from "zlib";
import { PDFDocument } from "pdf-lib";
import { generateClaimPdf, type PdfLineItem } from "@/lib/pdf/generate";
import { paginateItems } from "@/lib/pdf/paginate";
import { variantRowsFor } from "@/lib/pdf/loadTemplate";
import { FORM_ROWS_PER_PAGE } from "@/lib/config";

/**
 * Large-row template variants (scripts/make-row-variants.mjs): the official
 * 13-row table redistributed over the same table area as 2/4/8 taller rows.
 * These tests pin the contract generate.ts relies on — official field names,
 * exactly N rows, rows sharing the official table band — and that filling a
 * variant actually produces the bigger row text the variants exist for.
 */

const VARIANTS = [2, 4, 8] as const;
// Official table geometry (see scripts/make-row-variants.mjs).
const BAND_TOP_Y = 563.04;
const BAND_H = 251.16;
const FIELD_INSET = 0.96 + 0.6; // bottom border + top gap per row pitch

const asset = (name: string) => path.join(process.cwd(), "assets", name);
const variantBytes: Record<number, Uint8Array> = {};

beforeAll(async () => {
  for (const rows of VARIANTS) {
    variantBytes[rows] = new Uint8Array(
      await fs.readFile(asset(`cfcc-form-template-${rows}row.pdf`))
    );
  }
});

/** Inflate every flate stream so flattened appearance operators are searchable. */
function inflatedPdf(bytes: Uint8Array): string {
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
  return out;
}

const items = (n: number): PdfLineItem[] =>
  Array.from({ length: n }, (_, i) => ({
    description: `Item ${i + 1}`,
    amountCents: 1000 + i,
    ministry: "General Fund",
  }));

const claimInput = (templateBytes: Uint8Array, n: number) => ({
  requesterName: "Grace Chen",
  requesterAddress: "123 Mission Blvd, Hayward, CA 94544",
  dateString: "07/18/2026",
  items: items(n),
  receipts: [],
  templateBytes,
});

describe.each(VARIANTS)("%i-row template variant", (rows) => {
  it("keeps official field names for exactly its row count", async () => {
    const doc = await PDFDocument.load(variantBytes[rows]);
    const names = new Set(doc.getForm().getFields().map((f) => f.getName()));
    for (let row = 1; row <= rows; row++) {
      expect(names).toContain(`Description QuantityRow${row}`);
      expect(names).toContain(`AmountRow${row}`);
      expect(names).toContain(`For Ministry  EventRow${row}`);
    }
    expect(names).not.toContain(`Description QuantityRow${rows + 1}`);
    expect(names).not.toContain(`AmountRow${rows + 1}`);
    // Long ministry/event values wrap in the tall cells instead of shrinking
    // to fit one line (the official form's ministry cells stay single-line).
    const form = doc.getForm();
    for (let row = 1; row <= rows; row++) {
      expect(form.getTextField(`For Ministry  EventRow${row}`).isMultiline()).toBe(true);
    }
    // Everything outside the item rows is untouched.
    for (const kept of ["TotalAmount", "Make check payable to", "Requestor Name", "Request Date"]) {
      expect(names).toContain(kept);
    }
  });

  it("stretches its rows evenly over the official table band", async () => {
    const doc = await PDFDocument.load(variantBytes[rows]);
    const form = doc.getForm();
    const pitch = BAND_H / rows;
    for (let row = 1; row <= rows; row++) {
      const rect = form
        .getTextField(`Description QuantityRow${row}`)
        .acroField.getWidgets()[0]!
        .getRectangle();
      expect(rect.y).toBeCloseTo(BAND_TOP_Y - row * pitch + 0.96, 1);
      expect(rect.height).toBeCloseTo(pitch - FIELD_INSET, 1);
    }
  });

  it("fills via generateClaimPdf with row text grown to the legibility cap", async () => {
    const pdf = await generateClaimPdf(claimInput(variantBytes[rows], rows));
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
    // 8-row cells grow 8pt → 13pt; 4- and 2-row cells hit the 14pt cap.
    const grownSize = rows === 8 ? 13 : 14;
    expect(inflatedPdf(pdf)).toMatch(new RegExp(` ${grownSize} Tf`));
  });
});

describe("variantRowsFor (packet auto-pick)", () => {
  it("picks the smallest variant the whole claim fits on, else the official form", () => {
    expect(variantRowsFor(1)).toBe(2);
    expect(variantRowsFor(2)).toBe(2);
    expect(variantRowsFor(3)).toBe(4);
    expect(variantRowsFor(4)).toBe(4);
    expect(variantRowsFor(5)).toBe(8);
    expect(variantRowsFor(8)).toBe(8);
    expect(variantRowsFor(9)).toBe(13);
    expect(variantRowsFor(14)).toBe(13);
    expect(variantRowsFor(0)).toBe(13);
  });

  it("never changes the packet's form-page count", () => {
    // The print, certificate, and approved-packet paths locate the form pages
    // of an ALREADY-STORED packet as ceil(activeRows / FORM_ROWS_PER_PAGE).
    // Auto-picking must keep the real page count equal to that derivation:
    // variants only apply to claims that fit one page either way.
    for (let n = 1; n <= 40; n++) {
      const actual = paginateItems(Array.from({ length: n }), variantRowsFor(n)).length;
      expect(actual).toBe(Math.max(1, Math.ceil(n / FORM_ROWS_PER_PAGE)));
    }
  });
});

it("official 13-row template still renders row values at the design size", async () => {
  const officialBytes = new Uint8Array(await fs.readFile(asset("cfcc-form-template.pdf")));
  const pdf = await generateClaimPdf(claimInput(officialBytes, 13));
  // The template's static header labels are 11.5pt; grown row sizes (13/14pt)
  // must not appear anywhere on the official form's fill.
  expect(inflatedPdf(pdf)).not.toMatch(/ 1[34] Tf/);
});
