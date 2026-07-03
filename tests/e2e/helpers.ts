import { Page, expect } from "@playwright/test";
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";

export const FIXTURES_DIR = path.join(__dirname, ".fixtures");

/** Render a realistic-looking receipt photo (JPEG) for upload fixtures. */
export async function makeReceiptFixture(
  fileName: string,
  opts: { refund?: boolean } = {}
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

  const height = 220 + lines.length * 44;
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
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
}

/** Upload fixture files through the Shoebox file input and wait for the cards. */
export async function uploadReceipts(page: Page, filePaths: string[]): Promise<void> {
  const before = await page.locator('[data-testid^="receipt-card-"]').count();
  await page.getByTestId("file-input").setInputFiles(filePaths);
  await expect(page.locator('[data-testid^="receipt-card-"]')).toHaveCount(before + filePaths.length, {
    timeout: 20_000,
  });
}
