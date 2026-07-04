import qrcode from "qrcode-generator";
import { rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * QR self-link stamp for generated form pages. The code encodes the claim's
 * capability URL (/c/<publicToken>) so the treasurer can pull up the digital
 * packet — always the LATEST generated version — from the printed sheet.
 *
 * Placement (measured on assets/cfcc-form-template.pdf, 612×792pt): the form
 * is dense, so the stamp borrows room from the "Note:" box — the widest
 * element whose content doesn't need its full 473pt. When a stamp is drawn,
 * the original note box (x 68.5..541, y 233.8..266.3) is painted over and
 * redrawn narrower with the same four notes re-flowed, and the QR sits in
 * the freed right-hand slot: right-aligned to the form's shared content
 * edge (x≈541) and vertically centered between the table's bottom rule
 * (y≈292.5) and the "Requested by" bar (y≈217.5), a quiet zone away from
 * all three neighbors. Without a stamp the template is left untouched.
 */

/** Original note box frame and text metrics (template measurements). */
const NOTE_BOX = {
  left: 68.5,
  right: 541,
  top: 266.3,
  bottom: 233.8,
  /** x of the "Note:" label and of the numbered items' column. */
  labelX: 79.9,
  itemsX: 112.1,
  /** Baselines of the two text lines. */
  line1Y: 254.9,
  line2Y: 242.3,
  borderWidth: 1,
} as const;

/** The church's note text, re-flowed verbatim into the narrowed box. */
const NOTE_LABEL = "Note:";
const NOTE_ITEMS = [
  "1. Attach invoice/receipt to request form.",
  "2. Obtain approval from pastor/deacon.",
  "3. Return completed form to Treasurer’s in-box.",
  "4. Normal turn-around time is 1-2 weeks.",
] as const;

export const QR_STAMP = {
  /** Side length of the module area, pt. 56pt ≈ 19.8mm: a ~60-char URL is a
   *  37-module version-5 code → ≈0.53mm modules, comfortable for phones. */
  size: 56,
  /** Right edge, aligned with the form's shared content edge. */
  right: 541,
  /** Vertical center of the table-to-signature band (217.5..292.5). */
  centerY: 255,
  /** Right edge of the narrowed note box (leaves ≥ a 4-module quiet zone). */
  noteBoxRight: 477,
} as const;

/** Dark-module matrix for `url`, error-correction M (auto-sized version). */
export function qrMatrix(url: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(url, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

/**
 * Narrow the note box and draw the QR stamp in the freed slot beside it.
 * Call after form.flatten() so everything lands as plain page content.
 */
export function applyQrStamp(page: PDFPage, url: string, font: PDFFont): void {
  redrawNoteBox(page, font);
  drawQrModules(page, url);
}

/** Paint over the original full-width note box and redraw it narrower. */
function redrawNoteBox(page: PDFPage, font: PDFFont): void {
  const { left, right, top, bottom, labelX, itemsX, line1Y, line2Y, borderWidth } = NOTE_BOX;
  // Cover the old border stroke too (drawn centered on the frame path).
  page.drawRectangle({
    x: left - borderWidth,
    y: bottom - borderWidth,
    width: right - left + 2 * borderWidth,
    height: top - bottom + 2 * borderWidth,
    color: rgb(1, 1, 1),
  });
  page.drawRectangle({
    x: left,
    y: bottom,
    width: QR_STAMP.noteBoxRight - left,
    height: top - bottom,
    borderColor: rgb(0, 0, 0),
    borderWidth,
  });

  // Two-column layout like the original: items 1/3 left, 2/4 right. Shrink
  // from 8.5pt until the right column fits inside the narrowed frame.
  const innerRight = QR_STAMP.noteBoxRight - 8;
  const columnGap = 12;
  let size = 8.5;
  let colBX: number;
  for (; ; size -= 0.25) {
    const widestA = Math.max(
      font.widthOfTextAtSize(NOTE_ITEMS[0], size),
      font.widthOfTextAtSize(NOTE_ITEMS[2], size)
    );
    const widestB = Math.max(
      font.widthOfTextAtSize(NOTE_ITEMS[1], size),
      font.widthOfTextAtSize(NOTE_ITEMS[3], size)
    );
    colBX = itemsX + widestA + columnGap;
    if (colBX + widestB <= innerRight || size <= 6) break;
  }

  const black = rgb(0, 0, 0);
  page.drawText(NOTE_LABEL, { x: labelX, y: line1Y, size, font, color: black });
  page.drawText(NOTE_ITEMS[0], { x: itemsX, y: line1Y, size, font, color: black });
  page.drawText(NOTE_ITEMS[1], { x: colBX, y: line1Y, size, font, color: black });
  page.drawText(NOTE_ITEMS[2], { x: itemsX, y: line2Y, size, font, color: black });
  page.drawText(NOTE_ITEMS[3], { x: colBX, y: line2Y, size, font, color: black });
}

/**
 * Draw the QR modules as vector rectangles so the code stays crisp at any
 * print resolution; the blank slot around it doubles as the quiet zone.
 */
function drawQrModules(page: PDFPage, url: string): void {
  const matrix = qrMatrix(url);
  const n = matrix.length;
  const { size, right, centerY } = QR_STAMP;
  const module = size / n;
  const x0 = right - size;
  const yTop = centerY + size / 2;
  const black = rgb(0, 0, 0);

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c]) continue;
      page.drawRectangle({
        x: x0 + c * module,
        // 0.05pt overdraw hides hairline seams between adjacent modules that
        // some renderers show due to antialiasing.
        y: yTop - (r + 1) * module - 0.05,
        width: module + 0.05,
        height: module + 0.05,
        color: black,
      });
    }
  }
}
