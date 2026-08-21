/**
 * Network cost of the Shoebox wall: how many receipt-image requests fire on
 * first paint versus after a full scroll, and how many bytes that is. The
 * wall renders one <img> per receipt, so this is what bounds the page on a
 * phone plan — the number to watch as a user's shoebox grows.
 *
 *   node scripts/perf/measure-network.mjs [baseUrl]
 */
import { chromium } from "@playwright/test";

const base = process.argv[2] || "http://127.0.0.1:3200";
const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH;

const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.6,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();

let imgCount = 0;
let imgBytes = 0;
let apiBytes = 0;
page.on("response", async (res) => {
  const url = res.url();
  if (!url.startsWith(base)) return;
  const len = Number(res.headers()["content-length"] || 0);
  if (/\/api\/receipts\/[^/]+\/(file|preview)/.test(url)) {
    imgCount++;
    imgBytes += len;
  } else if (url.includes("/api/")) {
    apiBytes += len;
  }
});

await page.goto(`${base}/signin`);
await page.getByTestId("dev-email").fill("perf@example.com");
await page.getByTestId("dev-name").fill("Perf Main");
await page.getByTestId("dev-signin").click();
await page.waitForURL(`${base}/`);

imgCount = 0;
imgBytes = 0;
apiBytes = 0;
await page.goto(`${base}/`, { waitUntil: "load" });
await page.waitForSelector('[data-testid^="receipt-card-"]');
await page.waitForTimeout(4000);
const cards = await page.locator('[data-testid^="receipt-card-"]').count();
console.log(
  `after first paint: ${cards} cards mounted, ${imgCount} image requests, ${(imgBytes / 1048576).toFixed(2)} MB images, ${(apiBytes / 1024).toFixed(0)} KB api`
);

await page.evaluate(async () => {
  const total = document.documentElement.scrollHeight - innerHeight;
  const t0 = performance.now();
  await new Promise((resolve) => {
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 2500);
      scrollTo(0, total * p);
      if (p < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
});
await page.waitForTimeout(6000);
console.log(
  `after full scroll:  ${imgCount} image requests, ${(imgBytes / 1048576).toFixed(2)} MB images`
);

await browser.close();
