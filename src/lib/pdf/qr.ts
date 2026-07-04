import qrcode from "qrcode-generator";
import { rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * QR self-link stamp for generated form pages. The code encodes the claim's
 * capability URL (/c/<publicToken>) so the treasurer can pull up the digital
 * packet — always the LATEST generated version — from the printed sheet.
 *
 * Placement (measured on assets/cfcc-form-template.pdf, 612×792pt): every
 * box on the form — title box, table, note box, signature blocks — ends at
 * x≈542pt, leaving the right margin column (x≈546..612) as the page's only
 * blank region tall enough for a scannable code. The stamp sits at the top
 * of that column: fully clear of the title box (top edge y≈738, so only the
 * stamp's lower strip has it as a horizontal neighbor, ≥ one quiet zone
 * away) and far from the paper edges enough that consumer printers don't
 * clip it. No white backing rect is needed because nothing is drawn beneath.
 */
export const QR_STAMP = {
  /** Side length of the module area, pt. 52pt ≈ 18.3mm: a ~60-char URL is a
   *  37-module version-5 code → ≈0.50mm modules, which phone cameras read
   *  at close range. Sized to fit the form's only fully-blank region. */
  size: 52,
  /** Distance from the right paper edge, pt (4.2mm — just outside consumer
   *  printers' unprintable strip). */
  marginRight: 12,
  /** Distance from the top paper edge, pt. */
  marginTop: 14,
  /** Caption font size, pt. */
  captionSize: 5.5,
  captionText: "Scan for digital copy",
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
 * Draw the QR stamp (plus caption) onto a page. Modules are drawn as vector
 * rectangles so the code stays crisp at any print resolution; the paper is
 * white, so the surrounding blank corner doubles as the quiet zone.
 */
export function drawQrStamp(page: PDFPage, url: string, captionFont: PDFFont): void {
  const matrix = qrMatrix(url);
  const n = matrix.length;
  const { size, marginRight, marginTop, captionSize, captionText } = QR_STAMP;
  const module = size / n;
  const x0 = page.getWidth() - marginRight - size;
  const yTop = page.getHeight() - marginTop;
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

  const captionWidth = captionFont.widthOfTextAtSize(captionText, captionSize);
  page.drawText(captionText, {
    x: x0 + (size - captionWidth) / 2,
    y: yTop - size - 3 - captionFont.heightAtSize(captionSize),
    size: captionSize,
    font: captionFont,
    color: rgb(0.35, 0.35, 0.35),
  });
}
