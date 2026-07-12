// Mobile visual walkthrough: drive the full localized journey at a phone
// viewport against the e2e server (tests/e2e/start-server.sh on :3100,
// AI_MOCK + AUTH_TEST_MODE) and capture a screenshot at each story beat.
// Output: screenshots/walkthrough/NN-*.png + packet.pdf.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { chromium } from "@playwright/test";

const BASE = "http://localhost:3100";
const OUT = "screenshots/walkthrough";
await mkdir(OUT, { recursive: true });

// The AI mock keys on the FILE NAME: "costco" → net 102.10, "*refund*" →
// charged 36.31 − refunded 5.36 (the derivation banner). Content is cosmetic.
async function fixture(fileName, lines) {
  const rows = lines
    .map(([l, r], i) => {
      const y = 170 + i * 44;
      return (
        `<text x="60" y="${y}" font-family="monospace" font-size="28" fill="#222">${l}</text>` +
        `<text x="740" y="${y}" font-family="monospace" font-size="28" fill="#222" text-anchor="end">${r}</text>`
      );
    })
    .join("");
  const height = 220 + lines.length * 44;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${height}">
    <rect width="800" height="${height}" fill="#fdfdf8"/>
    <text x="400" y="80" font-family="monospace" font-size="34" font-weight="bold" fill="#111" text-anchor="middle">RECEIPT</text>
    <line x1="40" y1="110" x2="760" y2="110" stroke="#999" stroke-dasharray="6 4"/>
    ${rows}
  </svg>`;
  const filePath = path.join(OUT, fileName);
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(filePath);
  return filePath;
}

const costco = await fixture("costco.jpg", [
  ["COSTCO WHOLESALE", ""],
  ["PAPER TOWELS", "24.99"],
  ["FOLDING TABLE", "77.11"],
  ["TOTAL", "102.10"],
]);
const refund = await fixture("amazon-refund.jpg", [
  ["AMAZON.COM", ""],
  ["CRAFT SUPPLIES", "36.31"],
  ["REFUND", "-5.36"],
  ["NET", "30.95"],
]);

const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  locale: "en-US",
});
const shot = (name, opts = {}) => page.screenshot({ path: `${OUT}/${name}.png`, ...opts });

// 1–2: sign-in, then switch language before ever signing in.
await page.goto(`${BASE}/signin`);
await shot("01-signin-en");
await page.getByTestId("locale-switcher").selectOption("zh-Hans");
await page.getByText("CFCC 费用报销", { exact: false }).waitFor();
await shot("02-signin-zh");

// 3: dev sign-in → empty Shoebox with the four-step onboarding.
await page.getByTestId("dev-email").fill("walkthrough@example.com");
await page.getByTestId("dev-name").fill("陈恩典");
await page.getByTestId("dev-signin").click();
await page.getByRole("heading", { name: "收据盒" }).waitFor();
await page.getByText("收据盒是空的").waitFor();
await shot("03-shoebox-empty", { fullPage: true });

// 4: pick two photos — the per-file prepare dialog (note + rotate/crop) comes
// first; Save/Skip is what actually uploads.
await page.getByTestId("file-input").setInputFiles([costco, refund]);
const noteInput = page.getByTestId("upload-note");
await noteInput.waitFor();
await noteInput.fill("青少年退修会点心 youth retreat snacks");
await shot("04-prepare-dialog");
await page.getByTestId("upload-note-confirm").click();
await noteInput.waitFor();
await page.getByTestId("upload-note-cancel").click();
await page.locator('[data-testid^="receipt-card-"]').nth(1).waitFor();

// 5: select both receipts → the sticky action bar arms New Claim.
for (const card of await page.locator('[data-testid^="receipt-card-"]').all()) await card.click();
await page.getByText("已选择 2 张收据").waitFor();
await shot("05-shoebox-selected", { fullPage: true });

// 6: build the claim (mock extraction) → review screen with the net-amount
// derivation banner on the refund receipt.
await page.getByTestId("generate-claim").click();
await page.getByRole("heading", { name: "核对报销单" }).waitFor({ timeout: 30_000 });
await page.getByText("消费", { exact: false }).first().waitFor();
await shot("06-review", { fullPage: true });

// 7: describe the claim → AI suggestion banner (mock keys on "youth retreat").
await page.getByTestId("claim-description").fill("youth retreat snacks 青少年退修会的点心");
await page.getByTestId("suggest-ministry").click();
await page.getByTestId("suggestion-banner").waitFor();
await shot("07-suggest");
await page.getByTestId("suggestion-apply").click();

// 8: verify every row (the accessible name stays 确认无误; pressed flips).
for (let i = 0; i < 2; i++) {
  await page.getByRole("button", { name: "确认无误", pressed: false }).first().click();
}
await page.getByText("已核对 2 / 2").waitFor();
await shot("08-verified", { fullPage: true });

// 9: generate the packet (real PDF download) → claim freezes as 已生成.
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.getByTestId("generate-pdf").click(),
]);
await download.saveAs(`${OUT}/packet.pdf`);
await page.getByTestId("claim-status").getByText("已生成").waitFor({ timeout: 20_000 });
await shot("09-generated", { fullPage: true });

// 10–11: claims list in Simplified, then the same page in Traditional.
await page.goto(`${BASE}/claims`);
await page.getByRole("heading", { name: "报销单" }).waitFor();
await shot("10-claims");
await page.getByTestId("locale-switcher").selectOption("zh-Hant");
await page.getByRole("heading", { name: "報銷單" }).waitFor();
await shot("11-claims-hant");

await browser.close();
console.log(`walkthrough captured in ${OUT}/`);
