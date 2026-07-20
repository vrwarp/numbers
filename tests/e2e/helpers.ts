import { Page, expect } from "@playwright/test";
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { PDFDocument, StandardFonts } from "pdf-lib";

export const FIXTURES_DIR = path.join(__dirname, ".fixtures");

/** Write a simple multi-page PDF receipt fixture for upload tests. */
export async function makePdfFixture(
  fileName: string,
  opts: { pages?: number } = {}
): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = opts.pages ?? 1;
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`RECEIPT — page ${i + 1} of ${pages}`, { x: 72, y: 700, size: 22, font });
    page.drawText("Costco Wholesale", { x: 72, y: 660, size: 14, font });
    page.drawText("TOTAL  102.10", { x: 72, y: 630, size: 14, font });
  }
  await fs.mkdir(FIXTURES_DIR, { recursive: true });
  const filePath = path.join(FIXTURES_DIR, fileName);
  await fs.writeFile(filePath, await doc.save());
  return filePath;
}

/** Render a realistic-looking receipt photo (JPEG) for upload fixtures.
 *  `heightPx` pads the canvas taller (long thermal-paper receipt) — the zoom
 *  tests need an image far taller than the review screen's clamp window. */
export async function makeReceiptFixture(
  fileName: string,
  opts: { refund?: boolean; heightPx?: number } = {}
): Promise<string> {
  const lines = opts.refund
    ? [
        ["COSTCO WHOLESALE", ""],
        ["REFUND / RETURN", ""],
        ["", ""],
        ["96716 KS PAPER TOWEL", "-27.98"],
        ["  QTY -2 @ 13.99", ""],
        ["TAX", "-2.59"],
        ["", ""],
        ["**** TOTAL", "-30.57"],
      ]
    : [
        ["COSTCO WHOLESALE", ""],
        ["SAN JOSE #482", ""],
        ["", ""],
        ["96716 KS PAPER TOWEL", "27.98"],
        ["  QTY 2 @ 13.99", ""],
        ["31855 SNACK VARIETY", "15.49"],
        ["77012 FOLDING TABLE 6FT", "49.99"],
        ["SUBTOTAL", "93.46"],
        ["TAX", "8.64"],
        ["**** TOTAL", "102.10"],
      ];

  const rows = lines
    .map(([left, right], i) => {
      const y = 170 + i * 44;
      return (
        `<text x="60" y="${y}" font-family="monospace" font-size="28" fill="#222">${left}</text>` +
        `<text x="740" y="${y}" font-family="monospace" font-size="28" fill="#222" text-anchor="end">${right}</text>`
      );
    })
    .join("");

  const height = Math.max(220 + lines.length * 44, opts.heightPx ?? 0);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${height}">
    <rect width="800" height="${height}" fill="#fdfdf8"/>
    <text x="400" y="80" font-family="monospace" font-size="34" font-weight="bold" fill="#111" text-anchor="middle">RECEIPT</text>
    <line x1="40" y1="110" x2="760" y2="110" stroke="#999" stroke-dasharray="6 4"/>
    ${rows}
    <line x1="40" y1="${height - 60}" x2="760" y2="${height - 60}" stroke="#999" stroke-dasharray="6 4"/>
  </svg>`;

  await fs.mkdir(FIXTURES_DIR, { recursive: true });
  const filePath = path.join(FIXTURES_DIR, fileName);
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(filePath);
  return filePath;
}

/** Sign in via the AUTH_TEST_MODE dev-login form. */
export async function signInAs(page: Page, email: string, name = "Test User"): Promise<void> {
  await page.goto("/signin");
  await page.getByTestId("dev-email").fill(email);
  await page.getByTestId("dev-name").fill(name);
  await page.getByTestId("dev-signin").click();
  await page.waitForURL("/");
  await expect(page.getByRole("heading", { name: "Receipts" })).toBeVisible();
}

/** Fill the profile via the API. The PDF route refuses to print a packet with
 *  blank payee lines, so any spec that generates a claim PDF needs this. */
export async function completeProfile(
  page: Page,
  name = "Test Member",
  address = "123 Main St, San Jose, CA 95110"
): Promise<void> {
  const res = await page.request.patch("/api/profile", {
    data: { fullName: name, mailingAddress: address },
  });
  expect(res.ok()).toBeTruthy();
}

/** Hydration guard for the Shoebox: the loading placeholder disappears only
 *  after the client fetch resolves, so React is interactive and the hidden
 *  file input's onChange is wired. A pick dispatched before that is silently
 *  dropped — the prepare dialog never opens and the spec dies at its first
 *  toBeVisible. Call before driving `file-input` directly. */
export async function shoeboxReady(page: Page): Promise<void> {
  await expect(page.getByTestId("receipts-loading")).toBeHidden({ timeout: 15_000 });
}

/** Upload fixture files through the Shoebox file input. Picking files opens a
 *  prepare dialog per file BEFORE anything uploads (client-side edit chance);
 *  Save sends that file — fill the optional note on the first, save through the
 *  rest, then wait for the cards to land. */
export async function uploadReceipts(page: Page, filePaths: string[], note?: string): Promise<void> {
  await shoeboxReady(page);
  const before = await page.locator('[data-testid^="receipt-card-"]').count();
  await page.getByTestId("file-input").setInputFiles(filePaths);
  const noteInput = page.getByTestId("upload-note");
  for (let i = 0; i < filePaths.length; i++) {
    await expect(noteInput).toBeVisible();
    if (i === 0 && note) await noteInput.fill(note);
    await page.getByTestId("upload-note-confirm").click();
  }
  await expect(noteInput).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('[data-testid^="receipt-card-"]')).toHaveCount(before + filePaths.length, {
    timeout: 20_000,
  });
}
