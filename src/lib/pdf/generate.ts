import { PDFDocument, PDFFont, rgb, StandardFonts } from "pdf-lib";
import { paginateItems } from "./paginate";
import { centsToDollarString } from "@/lib/money";

/**
 * The official CFCC "Invoice Payment / Expense Reimbursement Form" is a
 * fillable AcroForm PDF (bundled at assets/cfcc-form-template.pdf). Its table
 * holds 13 line-item rows per page; larger claims produce multiple filled
 * form pages. We fill the named fields, flatten each page so the values are
 * baked in, then append every receipt as an extra page.
 *
 * Field names on the template (as authored by the church):
 *   "Make check payable to"        requester name
 *   "Mail check to address"        address line 1
 *   "Make check to address 2"      address line 2
 *   "Description QuantityRow{n}"   description, rows 1..13
 *   "Description QuantityRow{n}_2" quantity (left blank — one row per receipt)
 *   "AmountRow{n}"                 amount
 *   "For Ministry  EventRow{n}"    ministry / event  (note the double space)
 *   "TotalAmount"                  grand total cell
 *   "Requestor Name" / "Request Date"   printed name + date (signature stays blank)
 */

const PAGE = { width: 612, height: 792 } as const;

export interface PdfLineItem {
  description: string;
  amountCents: number;
  ministry: string;
}

export interface PdfReceipt {
  data: Buffer | Uint8Array;
  mimeType: string;
  originalName: string;
}

export interface ClaimPdfInput {
  requesterName: string;
  requesterAddress: string;
  /** Pre-formatted date string, e.g. "07/03/2026". */
  dateString: string;
  items: PdfLineItem[];
  receipts: PdfReceipt[];
  /** The blank CFCC AcroForm template. */
  templateBytes: Uint8Array;
}

/** Usable text box inside a field widget, after pdf-lib's border+padding inset. */
interface FieldBounds {
  width: number;
  height: number;
}

// pdf-lib refuses to auto-size below 4pt; same floor for our best-effort fallback.
const MIN_DESCRIPTION_FONT_SIZE = 4;

/**
 * Largest font size ≤ maxSize at which every wrapped line of `text` stays
 * inside `bounds`. Mirrors pdf-lib's multiline appearance layout (greedy
 * word wrap by measured width, line height = 1.2 × font height) so the size
 * we pick matches what the renderer will actually clip against. A plain
 * character-count cutoff mis-sizes ALL-CAPS descriptions, whose glyphs are
 * far wider per character.
 */
export function fittingFontSize(
  text: string,
  font: PDFFont,
  bounds: FieldBounds,
  maxSize: number
): number {
  for (let size = maxSize; size > MIN_DESCRIPTION_FONT_SIZE; size--) {
    if (wrappedTextFits(text, font, bounds, size)) return size;
  }
  return MIN_DESCRIPTION_FONT_SIZE;
}

function wrappedTextFits(text: string, font: PDFFont, bounds: FieldBounds, size: number): boolean {
  let lines = 0;
  for (const paragraph of text.split(/[\n\f\r]/)) {
    lines += 1;
    const words = paragraph.split(" ");
    let remaining = bounds.width;
    for (let i = 0; i < words.length; i++) {
      const word = i < words.length - 1 ? `${words[i]} ` : words[i];
      const wordWidth = font.widthOfTextAtSize(word, size);
      remaining -= wordWidth;
      if (remaining <= 0) {
        lines += 1;
        remaining = bounds.width - wordWidth;
      }
    }
  }
  return font.heightAtSize(size) * 1.2 * lines <= bounds.height;
}

export async function generateClaimPdf(input: ClaimPdfInput): Promise<Uint8Array> {
  if (!input.templateBytes?.length) {
    throw new Error("CFCC form template PDF is missing");
  }
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);

  const pages = paginateItems(input.items);
  const grandTotal = input.items.reduce((s, it) => s + it.amountCents, 0);

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const filled = await fillFormPage(input, pages[pageIndex], pageIndex, pages.length, grandTotal);
    const [page] = await doc.copyPages(filled, [0]);
    doc.addPage(page);
  }

  for (let i = 0; i < input.receipts.length; i++) {
    await appendReceipt(doc, helv, input.receipts[i], i + 1, input.receipts.length);
  }

  return doc.save();
}

/** Fill one copy of the template and flatten it so values are permanent. */
async function fillFormPage(
  input: ClaimPdfInput,
  items: PdfLineItem[],
  pageIndex: number,
  pageCount: number,
  grandTotalCents: number
): Promise<PDFDocument> {
  const tpl = await PDFDocument.load(input.templateBytes);
  const form = tpl.getForm();
  const helv = await tpl.embedFont(StandardFonts.Helvetica);

  const setText = (fieldName: string, value: string, fontSize?: number) => {
    try {
      const field = form.getTextField(fieldName);
      if (fontSize) field.setFontSize(fontSize);
      field.setText(value);
    } catch {
      // Field missing on a customized template — value is simply omitted.
      console.warn(`PDF template is missing field "${fieldName}"`);
    }
  };

  setText("Make check payable to", input.requesterName, 10);
  const [addr1, addr2] = splitAddress(input.requesterAddress);
  setText("Mail check to address", addr1, 10);
  setText("Make check to address 2", addr2, 10);

  // Composed descriptions ("Merchant MM/DD — summary") often exceed one line
  // at 8pt; shrink each one just enough that its wrapped lines stay inside
  // the row instead of being clipped by the field rect.
  const setDescription = (fieldName: string, value: string) => {
    try {
      const field = form.getTextField(fieldName);
      const widget = field.acroField.getWidgets()[0];
      let size = 8;
      if (widget) {
        const rect = widget.getRectangle();
        const inset = ((widget.getBorderStyle()?.getWidth() ?? 0) + 1) * 2;
        size = fittingFontSize(
          value,
          helv,
          { width: rect.width - inset, height: rect.height - inset },
          8
        );
      }
      field.setFontSize(size);
      field.setText(value);
    } catch {
      console.warn(`PDF template is missing field "${fieldName}"`);
    }
  };

  items.forEach((item, i) => {
    const row = i + 1;
    setDescription(`Description QuantityRow${row}`, item.description);
    setText(`AmountRow${row}`, centsToDollarString(item.amountCents), 9);
    setText(`For Ministry  EventRow${row}`, item.ministry, 8);
  });

  const isLastPage = pageIndex === pageCount - 1;
  setText("TotalAmount", isLastPage ? centsToDollarString(grandTotalCents) : "(continued)", 10);
  if (pageCount > 1) {
    setText("For Ministry  EventTotal", `Page ${pageIndex + 1} of ${pageCount}`, 8);
  }

  setText("Requestor Name", input.requesterName, 10);
  setText("Request Date", input.dateString, 10);
  // "Approved by" and "For Treasurer use only" stay blank — filled by hand.

  form.updateFieldAppearances(helv);
  form.flatten();
  return tpl;
}

/** Split a one-line mailing address across the form's two address lines. */
export function splitAddress(address: string): [string, string] {
  const trimmed = address.trim();
  if (trimmed.length <= 45) return [trimmed, ""];
  // Prefer to break at the comma closest to the middle.
  const commas = [...trimmed.matchAll(/,/g)].map((m) => m.index!);
  if (commas.length > 0) {
    const mid = trimmed.length / 2;
    const best = commas.reduce((a, b) => (Math.abs(a - mid) <= Math.abs(b - mid) ? a : b));
    return [trimmed.slice(0, best + 1).trim(), trimmed.slice(best + 1).trim()];
  }
  const space = trimmed.lastIndexOf(" ", 45);
  if (space === -1) return [trimmed.slice(0, 45), trimmed.slice(45)];
  return [trimmed.slice(0, space), trimmed.slice(space + 1)];
}

async function appendReceipt(
  doc: PDFDocument,
  font: PDFFont,
  receipt: PdfReceipt,
  index: number,
  total: number
): Promise<void> {
  const bytes = receipt.data instanceof Buffer ? new Uint8Array(receipt.data) : receipt.data;

  if (receipt.mimeType === "application/pdf") {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const copied = await doc.copyPages(src, src.getPageIndices());
    for (const p of copied) doc.addPage(p);
    return;
  }

  const image =
    receipt.mimeType === "image/png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const page = doc.addPage([PAGE.width, PAGE.height]);
  const margin = 36;
  const maxW = PAGE.width - margin * 2;
  const maxH = PAGE.height - margin * 2 - 20; // leave room for the label
  const scale = Math.min(maxW / image.width, maxH / image.height, 1);
  const w = image.width * scale;
  const h = image.height * scale;
  page.drawText(`Receipt ${index} of ${total} — ${receipt.originalName}`, {
    x: margin,
    y: PAGE.height - margin + 6,
    size: 9,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });
  page.drawImage(image, {
    x: (PAGE.width - w) / 2,
    y: PAGE.height - margin - 14 - h,
    width: w,
    height: h,
  });
}
