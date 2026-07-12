// Capture the localized UI for review: sign in via dev login, switch language,
// screenshot the Shoebox onboarding + a review screen. Run against the e2e
// server (tests/e2e/start-server.sh on :3100).
import { chromium } from "@playwright/test";

const BASE = "http://localhost:3100";
const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });

await page.goto(`${BASE}/signin`);
await page.getByTestId("locale-switcher").selectOption("zh-Hant");
await page.getByTestId("dev-email").fill("screenshot-zh@example.com");
await page.getByTestId("dev-name").fill("陳恩典");
await page.getByTestId("dev-signin").click();
await page.getByRole("heading", { name: "收據" }).waitFor();
await page.screenshot({ path: "screenshots/zh-hant-shoebox.png", fullPage: true });

await page.getByTestId("locale-switcher").selectOption("zh-Hans");
await page.getByRole("heading", { name: "收据" }).waitFor();
await page.screenshot({ path: "screenshots/zh-hans-shoebox.png", fullPage: true });

await page.goto(`${BASE}/profile`);
await page.getByTestId("profile-locale").waitFor();
await page.screenshot({ path: "screenshots/zh-hans-profile.png", fullPage: true });

await browser.close();
console.log("saved screenshots/zh-hant-shoebox.png, zh-hans-shoebox.png, zh-hans-profile.png");
