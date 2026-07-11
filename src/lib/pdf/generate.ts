import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";
import { paginateItems } from "./paginate";
import { applyQrStamp } from "./qr";
import { centsToDollarString } from "@/lib/money";
import type { SignaturePlacement } from "@/lib/esign/placement";

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
  /** Optional user-written description, appended to the page label. */
  note?: string;
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
  /**
   * Capability URL of this claim's own packet (/c/<publicToken>). When set,
   * every form page gets a QR stamp beside the (narrowed) note box linking
   * back to the latest generated version; omitted (e.g. PUBLIC_BASE_URL not
   * configured) the pages are unchanged.
   */
  selfLinkUrl?: string;
  /**
   * The requestor's hand-drawn signature, click-placed on the form during the
   * submit ceremony (docs/ESIGN_DESIGN.md — click-to-stamp). Stamped at the
   * chosen coordinates on the first form page, INSIDE the hash-bound bytes the
   * submission freezes. Omitted → blank signature line (generation / classic
   * print-and-wet-sign flow).
   */
  requestorSignature?: { png: Uint8Array; placement: SignaturePlacement };
}

/** Usable text box inside a field widget, after pdf-lib's border+padding inset. */
interface FieldBounds {
  width: number;
  height: number;
}

// pdf-lib refuses to auto-size below 4pt; same floor for our best-effort fallback.
const MIN_FONT_SIZE = 4;

/**
 * Largest font size ≤ maxSize at which `text` stays inside `bounds`.
 * Mirrors pdf-lib's field appearance layout — multiline fields wrap greedily
 * by measured word width with 1.2 × font height per line; single-line fields
 * clip anything wider than the box — so the size we pick matches what the
 * renderer will actually clip against. A plain character-count cutoff
 * mis-sizes ALL-CAPS text, whose glyphs are far wider per character.
 */
export function fittingFontSize(
  text: string,
  font: PDFFont,
  bounds: FieldBounds,
  maxSize: number,
  multiline = true
): number {
  for (let size = maxSize; size > MIN_FONT_SIZE; size--) {
    if (textFits(text, font, bounds, size, multiline)) return size;
  }
  return MIN_FONT_SIZE;
}

function textFits(
  text: string,
  font: PDFFont,
  bounds: FieldBounds,
  size: number,
  multiline: boolean
): boolean {
  if (!multiline) {
    return (
      font.widthOfTextAtSize(text, size) <= bounds.width &&
      font.heightAtSize(size) <= bounds.height
    );
  }
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

/**
 * Standard Helvetica only encodes WinAnsi (Latin-ish) characters; pdf-lib
 * renders a field containing anything else (e.g. a CJK merchant name) as a
 * completely BLANK appearance — the entire value vanishes from the printed
 * form. Keep the encodable part and mark each dropped run with a single "…"
 * so the omission stays visible next to the attached receipt.
 */
export function toEncodableText(text: string, font: PDFFont): string {
  const charset = new Set(font.getCharacterSet());
  let out = "";
  let inDroppedRun = false;
  for (const ch of text) {
    if (/\s/.test(ch) || charset.has(ch.codePointAt(0)!)) {
      out += ch;
      inDroppedRun = false;
    } else if (!inDroppedRun) {
      out += "…";
      inDroppedRun = true;
    }
  }
  return out === text ? text : out.replace(/[^\S\n\f\r]+/g, " ").trim();
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

  // Values that don't fit their field at the design size (wide ALL-CAPS
  // descriptions, long ministry names, long addresses) shrink just enough to
  // stay inside the field rect instead of being clipped by it.
  const setText = (fieldName: string, rawValue: string, maxFontSize: number) => {
    try {
      const value = toEncodableText(rawValue, helv);
      const field = form.getTextField(fieldName);
      const widget = field.acroField.getWidgets()[0];
      let size = maxFontSize;
      if (widget) {
        const rect = widget.getRectangle();
        const inset = ((widget.getBorderStyle()?.getWidth() ?? 0) + 1) * 2;
        size = fittingFontSize(
          value,
          helv,
          { width: rect.width - inset, height: rect.height - inset },
          maxFontSize,
          field.isMultiline()
        );
      }
      field.setFontSize(size);
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

  items.forEach((item, i) => {
    const row = i + 1;
    setText(`Description QuantityRow${row}`, item.description, 8);
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
  // "Approved by" and "For Treasurer use only" stay blank here — the approver's
  // ink is stamped on the certificate delivery copy after approval (the packet
  // bytes are frozen under signature by then; see the certificate route).

  form.updateFieldAppearances(helv);
  form.flatten();

  // Stamped AFTER flattening so the QR (and the narrowed note box that makes
  // room for it) is plain page content like the baked field values; every
  // form page carries it so any sheet of a multi-page claim can be scanned.
  if (input.selfLinkUrl) {
    applyQrStamp(tpl.getPage(0), input.selfLinkUrl, helv);
  }
  // The requestor's click-placed signature (page 0 only; multi-page packets
  // sign on the first form page).
  if (input.requestorSignature?.png.length && pageIndex === 0) {
    await stampSignatureAt(tpl, tpl.getPage(0), input.requestorSignature.png, input.requestorSignature.placement);
  }
  return tpl;
}

/**
 * The CFCC form's "(Signature)" lines have NO AcroForm field — they sit to
 * the LEFT of the "Name (Please print)" field on the same baseline. The
 * default click-to-stamp anchor for a role is derived from that name field's
 * rect: bottom-left on the signature column. Returned as a page-normalized
 * placement (docs/ESIGN_DESIGN.md — click-to-stamp) so the UI can seed the
 * draggable stamp on the right line and the user just confirms.
 */
export async function signatureAnchor(
  templateBytes: Uint8Array,
  role: "requestor" | "approver"
): Promise<SignaturePlacement> {
  const tpl = await PDFDocument.load(templateBytes);
  const page = tpl.getPage(0);
  const pageW = page.getWidth();
  const pageH = page.getHeight();
  const fieldName = role === "requestor" ? "Requestor Name" : "Approver Name";
  let y = role === "requestor" ? 182 : 129; // template fallbacks (612×792)
  try {
    const rect = tpl.getForm().getTextField(fieldName).acroField.getWidgets()[0]?.getRectangle();
    if (rect) y = rect.y;
  } catch {
    // customized template without the field — fall back to the constant
  }
  return { page: 0, xRatio: 96 / pageW, yRatio: y / pageH, widthRatio: 144 / pageW };
}

/**
 * Draw a hand-drawn signature PNG at a page-normalized placement (bottom-left
 * origin). Width follows widthRatio; height preserves the image's aspect.
 */
export async function stampSignatureAt(
  doc: PDFDocument,
  page: PDFPage,
  png: Uint8Array,
  placement: SignaturePlacement
): Promise<void> {
  const image = await doc.embedPng(png);
  const pageW = page.getWidth();
  const pageH = page.getHeight();
  const w = placement.widthRatio * pageW;
  const h = w * (image.height / image.width);
  page.drawImage(image, {
    x: placement.xRatio * pageW,
    y: placement.yRatio * pageH,
    width: w,
    height: h,
  });
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

  // pdf-lib embeds only PNG/JPEG; stored receipt images are WebP now — transcode
  // anything else to JPEG first (dynamic import: sharp is server-only native code).
  let imageBytes: Uint8Array = bytes;
  let embedAsPng = receipt.mimeType === "image/png";
  if (receipt.mimeType !== "image/png" && receipt.mimeType !== "image/jpeg") {
    const sharp = (await import("sharp")).default;
    imageBytes = new Uint8Array(await sharp(Buffer.from(bytes)).jpeg({ quality: 85 }).toBuffer());
    embedAsPng = false;
  }
  const image = embedAsPng ? await doc.embedPng(imageBytes) : await doc.embedJpg(imageBytes);
  const page = doc.addPage([PAGE.width, PAGE.height]);
  const margin = 36;
  const maxW = PAGE.width - margin * 2;
  const maxH = PAGE.height - margin * 2 - 20; // leave room for the label
  const scale = Math.min(maxW / image.width, maxH / image.height, 1);
  const w = image.width * scale;
  const h = image.height * scale;
  // drawText has no clipping — a long file name or note would run past the
  // page edge, so shrink a little and then truncate with an ellipsis.
  let label = toEncodableText(
    `Receipt ${index} of ${total} — ${receipt.originalName}${
      receipt.note ? ` — ${receipt.note}` : ""
    }`,
    font
  );
  let labelSize = 9;
  while (labelSize > 7 && font.widthOfTextAtSize(label, labelSize) > maxW) labelSize--;
  if (font.widthOfTextAtSize(label, labelSize) > maxW) {
    while (label.length > 0 && font.widthOfTextAtSize(`${label}…`, labelSize) > maxW) {
      label = label.slice(0, -1);
    }
    label += "…";
  }
  page.drawText(label, {
    x: margin,
    y: PAGE.height - margin + 6,
    size: labelSize,
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
