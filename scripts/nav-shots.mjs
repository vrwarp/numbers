// NavBar-at-phone-width check: capture the signed-in nav in all three locales
// plus the Profile page (mobile home of the sign-out button) against the e2e
// server (tests/e2e/start-server.sh on :3100). Output: screenshots/nav/*.png.
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const BASE = "http://localhost:3100";
const OUT = "screenshots/nav";
await mkdir(OUT, { recursive: true });

const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  locale: "en-US",
});
const nav = (name) =>
  page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 0, y: 0, width: 390, height: 120 } });

await page.goto(`${BASE}/signin`);
await page.getByTestId("dev-email").fill("nav-shots@example.com");
await page.getByTestId("dev-name").fill("Grace Chen");
await page.getByTestId("dev-signin").click();

await page.getByRole("heading", { name: "Receipts" }).waitFor();
await nav("nav-en");
await page.screenshot({ path: `${OUT}/page-en.png` });

await page.getByTestId("locale-switcher").selectOption("zh-Hans");
await page.getByRole("heading", { name: "收据" }).waitFor();
await nav("nav-zh-hans");
await page.screenshot({ path: `${OUT}/page-zh-hans.png` });

await page.getByTestId("locale-switcher").selectOption("zh-Hant");
await page.getByRole("heading", { name: "收據" }).waitFor();
await nav("nav-zh-hant");

// Sign-out lives on the Profile page at phone widths — show it.
await page.goto(`${BASE}/profile`);
await page.getByTestId("profile-sign-out").waitFor();
await page.screenshot({ path: `${OUT}/profile-signout-zh-hant.png`, fullPage: true });

await browser.close();
console.log(`nav shots captured in ${OUT}/`);
