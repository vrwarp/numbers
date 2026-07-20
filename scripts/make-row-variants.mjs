// Build large-row variants of assets/cfcc-form-template.pdf: the official
// table's 13 item rows are redistributed over the SAME table area as fewer,
// taller rows (default 5 and 9), so short claims can print with far more
// legible line items. Everything outside the item-row band (header bar, Total
// row, note box, signature blocks) is untouched, and the surviving fields keep
// the official names ("Description QuantityRow{n}", "AmountRow{n}", …) so
// generate.ts fills a variant unchanged — it reads widget rects at runtime and
// scales the font to the taller cells. Rows beyond N are deleted from the form.
//
// Table lines: rather than erase each of the 12 original row borders in place
// (which leaves fractional-pixel remnants that render as a faintly dashed
// line), we white out the whole interior of the row band ONCE and redraw every
// line fresh at native width on clean paper — uniform, crisp borders.
//
// Reads the bundled 13-row template, writes assets/cfcc-form-template-{N}row.pdf.
// Run from the repo root:  node scripts/make-row-variants.mjs [N ...]   (default: 5 9)
import fs from "fs";
import { PDFDocument, rgb } from "pdf-lib";

const TEMPLATE = new URL("../assets/cfcc-form-template.pdf", import.meta.url);
const OFFICIAL_ROWS = 13;

// Measured geometry of the (quantity-shrunk) official template, PDF points.
const BORDER = 0.96; // stroke thickness used throughout the table
// The item-row band spans between two horizontal rules we KEEP: the header
// bar's bottom rule (band top) and row 13's bottom rule, which doubles as the
// Total row's top rule (band bottom).
const BAND_TOP_Y = 563.04; // header-bottom rule sits at y 563.04..564.00
const BAND_BOTTOM_Y = 311.88; // total-top rule sits at y 311.88..312.84
const BAND_H = BAND_TOP_Y - BAND_BOTTOM_Y; // 251.16 = 13 × 19.32 official pitch
// Interior surface between the two outer vertical borders (left 68.40..69.36,
// right 541.56..542.52) and between the two kept horizontal rules — the region
// we white out and rebuild. Insets land exactly on existing black/white edges
// so the erase adds no new anti-aliased seam against anything we keep.
const INNER_LEFT = 69.36;
const INNER_RIGHT = 541.56;
const INNER_W = INNER_RIGHT - INNER_LEFT;
const ERASE_BOTTOM = BAND_BOTTOM_Y + BORDER; // 312.84, just above the kept rule
const ERASE_H = BAND_TOP_Y - ERASE_BOTTOM; // up to the kept header rule
// The three interior column dividers (Description|Qty, Qty|Amount,
// Amount|Ministry), from the field-cell gaps. Redrawn full band height so they
// meet both kept rules; the outer borders are never erased, so not redrawn.
const DIVIDER_XS = [264.12, 302.16, 385.2];
// Row-1 field rects: y sits BORDER above the row's bottom line, height leaves
// a 0.6pt gap below the line above. Same x/width for every row of a column.
const FIELD_TOP_GAP = 0.6;
const ROW_FIELDS = ["Description QuantityRow{n}", "Description QuantityRow{n}_2", "AmountRow{n}", "For Ministry  EventRow{n}"];

const targets = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [5, 9];
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

  // 1) White out the whole band interior — every original row rule and the
  //    band portion of the interior dividers go with it, leaving clean paper.
  page.drawRectangle({ x: INNER_LEFT, y: ERASE_BOTTOM, width: INNER_W, height: ERASE_H, color: white });

  // 2) Redraw the three interior dividers full band height (spanning from the
  //    kept bottom rule to the kept top rule so they connect to both).
  for (const x of DIVIDER_XS) {
    page.drawRectangle({ x, y: BAND_BOTTOM_Y, width: BORDER, height: BAND_H + BORDER, color: black });
  }

  // 3) Redraw the N-1 interior row rules at the new pitch, meeting both outer
  //    borders' inner edges.
  for (let k = 1; k < rows; k++) {
    page.drawRectangle({ x: INNER_LEFT, y: BAND_TOP_Y - k * pitch, width: INNER_W, height: BORDER, color: black });
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
