// Visual walkthrough of the redesigned claim-review AI box: describe → up to
// three ranked candidates → tap to apply (no extra model call), with the
// "Something else…" escape hatch spending the one terminal follow-up.
// Drives the e2e server (:3100, AI_MOCK + AUTH_TEST_MODE) at a phone viewport
// and screenshots each beat. Output: screenshots/ai-box/NN-*.png.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { chromium } from "@playwright/test";

const BASE = "http://localhost:3100";
const OUT = "screenshots/ai-box";
await mkdir(OUT, { recursive: true });

// Minimal receipt fixture (mock extraction keys on nothing here — the AI box
// flow is driven by the description we type, not receipt content).
async function fixture(fileName, lines) {
  const rows = lines
    .map(([l, r], i) => {
      const y = 150 + i * 40;
      return (
        `<text x="55" y="${y}" font-family="monospace" font-size="26" fill="#222">${l}</text>` +
        `<text x="745" y="${y}" font-family="monospace" font-size="26" fill="#222" text-anchor="end">${r}</text>`
      );
    })
    .join("");
  const height = 200 + lines.length * 40;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${height}">
    <rect width="800" height="${height}" fill="#fdfdf8"/>
    <text x="400" y="70" font-family="monospace" font-size="32" font-weight="bold" fill="#111" text-anchor="middle">RECEIPT</text>
    <line x1="40" y1="100" x2="760" y2="100" stroke="#999" stroke-dasharray="6 4"/>
    ${rows}</svg>`;
  const filePath = path.join(OUT, fileName);
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(filePath);
  return filePath;
}

const a = await fixture("supplies-a.jpg", [
  ["MICHAELS STORES", ""],
  ["CRAFT SUPPLIES", "41.20"],
  ["TOTAL", "41.20"],
]);
const b = await fixture("supplies-b.jpg", [
  ["TARGET", ""],
  ["PAPER GOODS", "18.75"],
  ["TOTAL", "18.75"],
]);

const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  locale: "en-US",
});
const shot = (name, opts = {}) => page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
const panel = () => page.getByTestId("claim-ministry-panel");
const shotPanel = (name) => panel().screenshot({ path: `${OUT}/${name}.png` });

// Sign in (dev) → upload two receipts → build the claim → review screen.
await page.goto(`${BASE}/signin`);
await page.getByTestId("dev-email").fill("ai-box@example.com");
await page.getByTestId("dev-name").fill("Ada Boxwell");
await page.getByTestId("dev-signin").click();
await page.getByRole("heading", { name: "Receipts" }).waitFor();

await page.getByTestId("file-input").setInputFiles([a, b]);
const note = page.getByTestId("upload-note");
await note.waitFor();
await page.getByTestId("upload-note-confirm").click();
await note.waitFor();
await page.getByTestId("upload-note-confirm").click();
await page.locator('[data-testid^="receipt-card-"]').nth(1).waitFor();
for (const card of await page.locator('[data-testid^="receipt-card-"]').all()) await card.click();
await page.getByTestId("generate-claim").click();
await page.getByRole("heading", { name: "Review claim" }).waitFor({ timeout: 30_000 });

// 01 — the AI zone at rest: a distinct violet "surface" with a roomy prompt +
// Send, and the manual dropdowns below an "or set it yourself" divider.
await panel().scrollIntoViewIfNeeded();
await shotPanel("01-ai-zone-idle");

// 02 — describe an ambiguous claim and Send → up to three ranked candidates,
// each a fully-resolved budget line. (mock: "retreat" → 3 retreat lines.)
await page.getByTestId("claim-description").fill("supplies for the retreat");
await page.getByTestId("suggest-ministry").click();
await page.getByTestId("suggestion-candidate-2").waitFor();
await shotPanel("02-candidates");

// 03 — reject them all: "Something else…" opens the one terminal follow-up.
await page.getByTestId("suggestion-other").click();
await page.getByTestId("suggestion-followup").waitFor();
await shotPanel("03-something-else");

// 04 — the follow-up detail steers the second (and last) call to a single
// answer; the escape hatch is now "pick manually", so no third call exists.
await page.getByTestId("suggestion-followup").fill("it was VBS, not a retreat");
await page.getByTestId("suggestion-followup-send").click();
await page.getByTestId("suggestion-apply").waitFor();
await shotPanel("04-resolved");

// 05 — tap Apply → the category fans onto every row; applied banner + Undo.
await page.getByTestId("suggestion-apply").click();
await page.getByTestId("suggestion-undo").waitFor();
await shotPanel("05-applied");

// The row badges now carry the applied category — capture the whole page so the
// fan-out onto both receipts is visible.
await page.locator('[data-testid^="row-ministry-badge-"]').first().waitFor();
await shot("06-fanned-out", { fullPage: true });

// 07 — the confident single case: start over, describe something unambiguous →
// one candidate, rendered as the familiar suggestion banner.
await page.getByTestId("suggestion-undo").click();
await page.getByTestId("suggestion-dismiss").click();
await page.getByTestId("claim-description").fill("printer paper for the office");
await page.getByTestId("suggest-ministry").click();
await page.getByTestId("suggestion-apply").waitFor();
await shotPanel("07-confident-single");

await browser.close();
console.log(`AI-box walkthrough captured in ${OUT}/`);
