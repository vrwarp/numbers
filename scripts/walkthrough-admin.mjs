// Visual walkthrough of the admin interface: church-context editor (the main
// job) plus the comprehensive surface — overview/problems, settings, usage,
// logs, and members/roster. Drives the e2e server (:3100, AI_MOCK +
// AUTH_TEST_MODE) at a desktop viewport and screenshots each tab. The signed-in
// user is made admin by ADMIN_EMAILS (dogfooding the seed path), so start the
// server with that env — see the header of build-admin-walkthrough.mjs.
// Output: screenshots/admin/NN-*.png.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { chromium } from "@playwright/test";

const BASE = "http://localhost:3100";
const OUT = "screenshots/admin";
const ADMIN_EMAIL = "church-admin@example.org";
await mkdir(OUT, { recursive: true });

// A plain receipt fixture — mock extraction keys on the filename, not content;
// a plain name extracts as a Costco line so the seeded claim has real numbers.
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

const a = await fixture("supplies-a.jpg", [["MICHAELS", ""], ["CRAFT SUPPLIES", "41.20"], ["TOTAL", "41.20"]]);
const b = await fixture("supplies-b.jpg", [["TARGET", ""], ["PAPER GOODS", "18.75"], ["TOTAL", "18.75"]]);

const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({
  viewport: { width: 1200, height: 900 },
  deviceScaleFactor: 2,
  locale: "en-US",
});

const dash = () => page.getByTestId("admin-dashboard");
const shotDash = (name) => dash().screenshot({ path: `${OUT}/${name}.png` });
const tab = async (id) => {
  await page.getByTestId(`admin-tab-${id}`).click();
  await page.waitForTimeout(350); // let the tab's fetch settle
};

// --- Sign in (dev) as the ADMIN_EMAILS address ------------------------------
await page.goto(`${BASE}/signin`);
await page.getByTestId("dev-email").fill(ADMIN_EMAIL);
await page.getByTestId("dev-name").fill("Grace Chen");
await page.getByTestId("dev-signin").click();
await page.getByRole("heading", { name: "Receipts" }).waitFor();

// --- Seed one claim so Usage / Logs / Overview have real data ---------------
await page.getByTestId("file-input").setInputFiles([a, b]);
await page.getByTestId("upload-note").waitFor();
await page.getByTestId("upload-note-confirm").click();
await page.getByTestId("upload-note").waitFor();
await page.getByTestId("upload-note-confirm").click();
await page.locator('[data-testid^="receipt-card-"]').nth(1).waitFor();
for (const card of await page.locator('[data-testid^="receipt-card-"]').all()) await card.click();
await page.getByTestId("generate-claim").click();
await page.getByRole("heading", { name: "Review claim" }).waitFor({ timeout: 30_000 });

// --- Into the admin area ----------------------------------------------------
await page.getByRole("link", { name: "Admin" }).click();
await dash().waitFor();

// 01 — Overview: the "problems" panel + headline numbers (the landing).
await tab("overview");
await page.getByTestId("health-panel").waitFor();
await shotDash("01-overview");

// 02 — Church Context: the main job. Type vocabulary and save.
await tab("context");
await page.getByTestId("context-editor").waitFor();
await page.getByTestId("context-editor").fill(
  [
    "# Vocabulary & aliases",
    "- “the retreat” = the all-church Summer Retreat.",
    "- “Footprint” / “youth group” = the youth fellowship.",
    "",
    "# Labeling rules",
    "- Food/snacks default to Luncheon Catering unless tied to a named event.",
    "- Cleaning & paper goods for the building are Janitorial, not Office Supplies.",
  ].join("\n")
);
await page.getByTestId("context-save").click();
await page.getByTestId("context-saved").waitFor();
await shotDash("02-context");

// 03 — Settings: grouped, plain-language config; secrets are write-only.
await tab("settings");
await page.getByTestId("settings-tab").waitFor();
await shotDash("03-settings");

// 04 — Usage: honest counts, the 30-day AI-call chart, real settled money.
await tab("usage");
await page.getByTestId("usage-tab").waitFor();
await page.getByTestId("ai-chart").waitFor();
await shotDash("04-usage");

// 05 — Logs: show all AI calls (mock all-succeed) + the audit trail below.
await tab("logs");
await page.getByTestId("logs-tab").waitFor();
await page.getByTestId("extraction-all").check();
await page.waitForTimeout(350);
await page.getByTestId("audit-row").first().waitFor();
await shotDash("05-logs");

// 06 — Members: the verified-mirror roster table + the e-sign master switch.
await tab("members");
await page.getByTestId("members-tab").waitFor();
await page.locator('[data-testid^="member-"]').first().waitFor();
await shotDash("06-members");

await browser.close();
console.log(`Admin walkthrough captured in ${OUT}/`);
