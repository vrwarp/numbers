// One-time rework of assets/cfcc-form-template.pdf: the Quantity column is
// never filled (one row per receipt), so shrink it, rename its header to
// "Qty", and give the reclaimed width to Description. Field names and the
// 13-row layout are unchanged; generate.ts reads widget rects at runtime, so
// it needs no code changes. Idempotent — refuses to run on an already-shrunk
// template. Run from the repo root: node scripts/shrink-quantity-column.mjs
import fs from "fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const TEMPLATE = new URL("../assets/cfcc-form-template.pdf", import.meta.url);

// Measured geometry of the original template (all values in PDF points).
const BORDER = 0.96; // stroke thickness used throughout the table
const OLD_DIVIDER_X = 230.4; // vertical border between Description and Quantity
const QTY_AMOUNT_DIVIDER_X = 302.16;
const AMOUNT_MINISTRY_DIVIDER_X = 385.2;
const TABLE_RIGHT_X = 541.56;
const DIVIDER_Y = 292.56; // dividers span the total row + 13 item rows...
const DIVIDER_H = 270.48; // ...up to the header's bottom border at y=563.04
const ROW_LINE_X = 69.36; // full-width horizontal row borders
const ROW_LINE_YS = [
  543.72, 524.4, 505.08, 485.76, 466.44, 447.12, 427.8, 408.48, 389.16,
  369.84, 350.52, 331.2, 311.88,
];
const HEADER_BAR = { x: 69.36, y: 563.4, width: 472.8, height: 19.44 };
const TOTAL_CELL = { x: 230.88, y: 292.92, width: 71.88, height: 19.44 };

const NEW_QTY_FIELD_W = 36; // was 69.72 — still fits "Qty" and small counts
const HEADER_FONT_SIZE = 11.5;

const bytes = fs.readFileSync(TEMPLATE);
const doc = await PDFDocument.load(bytes);
const form = doc.getForm();
const page = doc.getPage(0);
const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);

const qty1 = form.getTextField("Description QuantityRow1_2").acroField.getWidgets()[0];
const delta = qty1.getRectangle().width - NEW_QTY_FIELD_W;
if (delta <= 0) {
  console.error("Template already has a shrunk Quantity column — nothing to do.");
  process.exit(1);
}

for (let row = 1; row <= 13; row++) {
  const desc = form.getTextField(`Description QuantityRow${row}`).acroField.getWidgets()[0];
  const qty = form.getTextField(`Description QuantityRow${row}_2`).acroField.getWidgets()[0];
  const d = desc.getRectangle();
  desc.setRectangle({ ...d, width: d.width + delta });
  const q = qty.getRectangle();
  qty.setRectangle({ ...q, x: q.x + delta, width: NEW_QTY_FIELD_W });
}

const newDividerX = OLD_DIVIDER_X + delta;
const black = rgb(0, 0, 0);
const white = rgb(1, 1, 1);

// Blank the strip between the old and new divider positions: the old divider,
// the (empty) reclaimed quantity-cell space, the left slice of the Total
// cell, and the crossing segments of every horizontal row border. Overshoot
// 1pt left and below so the strip's anti-aliased boundary pixels don't blend
// with the erased black underneath and leave a gray seam.
const bandW = newDividerX + BORDER - OLD_DIVIDER_X;
page.drawRectangle({
  x: OLD_DIVIDER_X - 1,
  y: DIVIDER_Y - 1,
  width: bandW + 1,
  height: DIVIDER_H + 1,
  color: white,
});

// Redraw the horizontal row-border segments the blank strip cut through
// (same 1pt overshoot; overlapping the surviving line is harmless).
for (const y of ROW_LINE_YS) {
  page.drawRectangle({ x: OLD_DIVIDER_X - 1, y, width: bandW + 1, height: BORDER, color: black });
}

// The divider itself, at its new position.
page.drawRectangle({ x: newDividerX, y: DIVIDER_Y, width: BORDER, height: DIVIDER_H, color: black });

// Rebuild the Total cell flush against the new divider (its remaining right
// part still shows fragments of the old centered label, so repaint whole).
const totalRight = TOTAL_CELL.x + TOTAL_CELL.width;
page.drawRectangle({
  x: newDividerX + BORDER,
  y: TOTAL_CELL.y,
  width: totalRight - (newDividerX + BORDER),
  height: TOTAL_CELL.height,
  color: black,
});
drawCentered("Total", newDividerX + BORDER, totalRight, TOTAL_CELL.y, TOTAL_CELL.height);

// Repaint the header bar and re-center all four labels in the new cells
// (one font for all labels keeps the header uniform).
page.drawRectangle({ ...HEADER_BAR, color: black });
drawCentered("Description", HEADER_BAR.x, newDividerX, HEADER_BAR.y, HEADER_BAR.height);
drawCentered("Qty", newDividerX + BORDER, QTY_AMOUNT_DIVIDER_X, HEADER_BAR.y, HEADER_BAR.height);
drawCentered("Amount", QTY_AMOUNT_DIVIDER_X + BORDER, AMOUNT_MINISTRY_DIVIDER_X, HEADER_BAR.y, HEADER_BAR.height);
drawCentered(
  "For Ministry / Event",
  AMOUNT_MINISTRY_DIVIDER_X + BORDER,
  TABLE_RIGHT_X,
  HEADER_BAR.y,
  HEADER_BAR.height
);

function drawCentered(text, left, right, cellY, cellH) {
  const width = helvBold.widthOfTextAtSize(text, HEADER_FONT_SIZE);
  const capHeight = helvBold.heightAtSize(HEADER_FONT_SIZE, { descender: false });
  page.drawText(text, {
    x: (left + right - width) / 2,
    y: cellY + (cellH - capHeight) / 2 + 1,
    size: HEADER_FONT_SIZE,
    font: helvBold,
    color: white,
  });
}

fs.writeFileSync(TEMPLATE, await doc.save());
console.log(
  `Done: Quantity column ${qty1.getRectangle().width}pt wide (was ${NEW_QTY_FIELD_W + delta}pt), ` +
    `Description widened by ${delta}pt.`
);
