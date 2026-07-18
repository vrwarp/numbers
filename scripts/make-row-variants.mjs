// Build large-row variants of assets/cfcc-form-template.pdf: the official
// table's 13 item rows are redistributed over the SAME table area as 2, 4 or
// 8 taller rows, so short claims can print with far more legible line items.
// Everything outside the item-row band (header bar, Total row, note box,
// signature blocks) is untouched, and the surviving fields keep the official
// names ("Description QuantityRow{n}", "AmountRow{n}", …) so generate.ts
// fills a variant unchanged — it reads widget rects at runtime and scales
// the font to the taller cells. Rows beyond N are deleted from the form.
//
// Reads the bundled 13-row template, writes assets/cfcc-form-template-{N}row.pdf.
// Run from the repo root:  node scripts/make-row-variants.mjs [N ...]   (default: 2 4 8)
import fs from "fs";
import { PDFDocument, rgb } from "pdf-lib";

const TEMPLATE = new URL("../assets/cfcc-form-template.pdf", import.meta.url);
const OFFICIAL_ROWS = 13;

// Measured geometry of the (quantity-shrunk) official template, PDF points.
const BORDER = 0.96; // stroke thickness used throughout the table
// The item-row band: from the top of row 13's bottom border (which doubles as
// the Total row's top border and is kept) up to the header bar's bottom border.
const BAND_TOP_Y = 563.04;
const BAND_BOTTOM_LINE_Y = 311.88;
const BAND_H = BAND_TOP_Y - BAND_BOTTOM_LINE_Y; // 251.16 = 13 × 19.32 row pitch
// Horizontal row borders start flush against the left outer border's right
// edge (x=68.4 w=0.96) and run THROUGH the right outer border (x=541.56).
const ROW_LINE_X = 69.36;
const ROW_LINE_W = 473.16;
// Vertical borders the erased strips cut through, redrawn afterwards: the
// three interior column dividers (Description|Qty, Qty|Amount,
// Amount|Ministry) plus the right outer border. The left outer border sits
// entirely left of the row lines and is never touched.
const DIVIDER_XS = [264.12, 302.16, 385.2, 541.56];
// Row-1 field rects: y sits BORDER above the row's bottom line, height leaves
// a 0.6pt gap below the line above. Same x/width for every row of a column.
const FIELD_TOP_GAP = 0.6;
const ROW_FIELDS = ["Description QuantityRow{n}", "Description QuantityRow{n}_2", "AmountRow{n}", "For Ministry  EventRow{n}"];

const targets = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [2, 4, 8];
for (const n of targets) {
  if (!Number.isInteger(n) || n < 1 || n >= OFFICIAL_ROWS) {
    console.error(`Row count ${n} must be an integer in 1..${OFFICIAL_ROWS - 1}`);
    process.exit(1);
  }
}

const bytes = fs.readFileSync(TEMPLATE);

for (const rows of targets) {
  const doc = await PDFDocument.load(new Uint8Array(bytes));
  const form = doc.getForm();
  const page = doc.getPage(0);
  const field = (name, row) => form.getTextField(name.replace("{n}", String(row)));
  try {
    field(ROW_FIELDS[0], OFFICIAL_ROWS);
  } catch {
    console.error("Template is not the official 13-row form — refusing to build variants.");
    process.exit(1);
  }

  const white = rgb(1, 1, 1);
  const black = rgb(0, 0, 0);
  const pitch = BAND_H / rows;

  // Erase the 12 interior row borders (row 13's bottom line survives as the
  // Total row's top border) over their exact horizontal extent, with 1pt
  // vertical overshoot so anti-aliased edge pixels can't linger as gray
  // seams. The strips cut every vertical border they cross — redrawn below.
  for (let k = 1; k < OFFICIAL_ROWS; k++) {
    const y = BAND_TOP_Y - k * (BAND_H / OFFICIAL_ROWS);
    page.drawRectangle({
      x: ROW_LINE_X,
      y: y - 1,
      width: ROW_LINE_W,
      height: BORDER + 2,
      color: white,
    });
  }
  // 0.2pt overdraw each side: the erase strips leave partially-white
  // anti-aliased pixels on the borders they crossed, and an exact-width
  // redraw can't restore full coverage on those boundary pixels.
  for (const x of DIVIDER_XS) {
    page.drawRectangle({
      x: x - 0.2,
      y: BAND_BOTTOM_LINE_Y + BORDER,
      width: BORDER + 0.4,
      height: BAND_H - BORDER,
      color: black,
    });
  }
  for (let k = 1; k < rows; k++) {
    page.drawRectangle({
      x: ROW_LINE_X,
      y: BAND_TOP_Y - k * pitch,
      width: ROW_LINE_W,
      height: BORDER,
      color: black,
    });
  }

  // Stretch rows 1..N over the new pitch; delete the fields beyond row N so
  // the variant IS an N-row form (generate.ts warns-and-omits on missing
  // fields, so an oversized claim degrades loudly rather than silently).
  for (let row = 1; row <= OFFICIAL_ROWS; row++) {
    for (const name of ROW_FIELDS) {
      const f = field(name, row);
      if (row > rows) {
        form.removeField(f);
        continue;
      }
      const widget = f.acroField.getWidgets()[0];
      const r = widget.getRectangle();
      widget.setRectangle({
        ...r,
        y: BAND_TOP_Y - row * pitch + BORDER,
        height: pitch - BORDER - FIELD_TOP_GAP,
      });
    }
    if (row <= rows) {
      // The official form's ministry cells are single-line (nothing wraps in
      // an 18pt row); in the tall variant cells a long ministry/event value
      // should wrap large instead of shrinking to fit one line. Description
      // is already multiline on the official form; Qty/Amount stay single.
      field("For Ministry  EventRow{n}", row).enableMultiline();
    }
  }

  const out = new URL(`../assets/cfcc-form-template-${rows}row.pdf`, import.meta.url);
  fs.writeFileSync(out, await doc.save());
  console.log(`wrote ${out.pathname} (${rows} rows, ${pitch.toFixed(2)}pt pitch)`);
}
