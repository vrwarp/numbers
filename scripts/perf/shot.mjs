/**
 * Screenshot the seeded Receipts wall (and the review screen) so a layout
 * change can be LOOKED at, not just asserted. Writes into screenshots/perf/
 * (gitignored).
 *
 *   node scripts/perf/shot.mjs [baseUrl]
 */
import fs from "node:fs";
import { chromium } from "@playwright/test";

const base = process.argv[2] || "http://127.0.0.1:3200";
const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const out = "screenshots/perf";
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch(exe ? { executablePath: exe } : {});

for (const [name, viewport, mobile] of [
  ["phone", { width: 412, height: 915 }, true],
  ["desktop", { width: 1440, height: 900 }, false],
]) {
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  await page.goto(`${base}/signin`);
  await page.getByTestId("dev-email").fill("perf@example.com");
  await page.getByTestId("dev-name").fill("Perf Main");
  await page.getByTestId("dev-signin").click();
  await page.waitForURL(`${base}/`);
  await page.waitForSelector('[data-testid^="receipt-card-"]');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}/wall-${name}.png` });

  // Selection state + a filter chip applied (the two states the memoized
  // tile has to keep correct).
  await page.locator('[data-testid^="receipt-select-"]').first().click();
  await page.locator('[data-testid^="receipt-select-"]').nth(3).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/wall-${name}-selected.png` });

  const chips = page.getByTestId("receipt-filters").locator("button");
  if (await chips.count()) {
    await chips.nth(await chips.count() - 1).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/wall-${name}-filtered.png` });
  }
  await context.close();
}

await browser.close();
console.log(`wrote ${fs.readdirSync(out).length} screenshots to ${out}/`);
