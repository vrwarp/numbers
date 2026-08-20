/**
 * Scroll-jank profile of the Shoebox wall, at two velocities:
 *
 *   fling  — ~3500px over 600ms then settle, ×4 (what a user's thumb does)
 *   stress — the whole wall traversed in 2.2s (fling-to-bottom worst case)
 *
 * Reports dropped-frame share (frames over 33.4ms = a visible hitch) and the
 * worst frame. Run against the seeded perf server; 4× CPU throttle + a phone
 * viewport, because jank only exists on mid-tier hardware.
 *
 *   node scripts/perf/scroll-ab.mjs [baseUrl]
 */
import { chromium } from "@playwright/test";

const base = process.argv[2] || "http://127.0.0.1:3200";
const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH;

/** Instrument rAF deltas across a scripted scroll and summarize the frames. */
async function profileScroll(page, mode) {
  return page.evaluate(async (mode) => {
    scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 600));
    const frames = [];
    let last = performance.now();
    let running = true;
    const tick = (now) => {
      frames.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const glide = (fromY, distance, ms) =>
      new Promise((resolve) => {
        const t0 = performance.now();
        const step = (now) => {
          const p = Math.min(1, (now - t0) / ms);
          // easeOutCubic ≈ a flick's deceleration curve
          scrollTo(0, fromY + distance * (1 - Math.pow(1 - p, 3)));
          if (p < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });

    if (mode === "fling") {
      for (let i = 0; i < 4; i++) {
        await glide(scrollY, 3500, 600);
        await new Promise((r) => setTimeout(r, 500)); // thumb lifts, page settles
      }
    } else {
      const total = document.documentElement.scrollHeight - innerHeight;
      const t0 = performance.now();
      await new Promise((resolve) => {
        const step = (now) => {
          const p = Math.min(1, (now - t0) / 2200);
          scrollTo(0, total * p);
          if (p < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
    }
    running = false;

    const over = frames.filter((f) => f > 33.4);
    const sorted = [...frames].sort((a, b) => a - b);
    return {
      frames: frames.length,
      jankyPct: +((over.length / frames.length) * 100).toFixed(1),
      p95Frame: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      worst: Math.round(Math.max(...frames)),
    };
  }, mode);
}

const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.6,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

await page.goto(`${base}/signin`);
await page.getByTestId("dev-email").fill("perf@example.com");
await page.getByTestId("dev-name").fill("Perf Main");
await page.getByTestId("dev-signin").click();
await page.waitForURL(`${base}/`);

for (const mode of ["fling", "stress"]) {
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForSelector('[data-testid^="receipt-card-"]');
  await page.waitForTimeout(3000);
  console.log(mode.padEnd(8), JSON.stringify(await profileScroll(page, mode)));
}

await browser.close();
