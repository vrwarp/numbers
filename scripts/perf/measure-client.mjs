/**
 * Client responsiveness / jank measurement against the seeded perf server:
 * loads the heavy surfaces in headless Chromium and reports, per page —
 *   TTFB / FCP / LCP           (paint timeline)
 *   CLS                        (cumulative layout shift, the jank users see)
 *   long tasks + TBT           (main-thread blocking after FCP)
 *   scroll jank                (dropped-frame share while auto-scrolling the wall)
 *   interaction latency        (filter chip click → next paint)
 *
 *   node scripts/perf/measure-client.mjs [baseUrl]
 *
 * Uses PLAYWRIGHT_CHROMIUM_PATH when set (sandboxes pre-install Chromium);
 * emulates a mid-tier phone (4× CPU throttle, Pixel-ish viewport) because
 * that is where jank actually lives.
 */
import { chromium } from "@playwright/test";

const base = process.argv[2] || "http://127.0.0.1:3200";
const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH;

const INIT = `
  window.__perf = { cls: 0, clsEntries: [], longTasks: [], lcp: 0, fcp: 0, inp: [] };
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      if (!e.hadRecentInput) {
        window.__perf.cls += e.value;
        if (e.value > 0.01) window.__perf.clsEntries.push({ v: +e.value.toFixed(4), t: Math.round(e.startTime) });
      }
    }
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__perf.longTasks.push({ d: Math.round(e.duration), t: Math.round(e.startTime) });
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((l) => {
    const last = l.getEntries().at(-1);
    if (last) window.__perf.lcp = Math.round(last.startTime);
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.name === "first-contentful-paint") window.__perf.fcp = Math.round(e.startTime);
  }).observe({ type: "paint", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__perf.inp.push({ name: e.name, dur: Math.round(e.duration) });
  }).observe({ type: "event", durationThreshold: 40, buffered: true });
`;

async function collect(page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const fcp = window.__perf.fcp;
    const tbt = window.__perf.longTasks
      .filter((t) => t.t > fcp)
      .reduce((s, t) => s + Math.max(0, t.d - 50), 0);
    return {
      ttfb: Math.round(nav.responseStart),
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
      fcp,
      lcp: window.__perf.lcp,
      cls: +window.__perf.cls.toFixed(4),
      clsEntries: window.__perf.clsEntries.slice(0, 8),
      longTasks: window.__perf.longTasks.length,
      longTaskWorst: Math.max(0, ...window.__perf.longTasks.map((t) => t.d)),
      tbt: Math.round(tbt),
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    };
  });
}

/** Auto-scroll to the bottom and report the share of frames over 33ms (2×60Hz
 *  budget — a visible hitch) plus the worst frame. */
async function scrollJank(page) {
  return page.evaluate(async () => {
    const frames = [];
    let last = performance.now();
    let raf = true;
    const tick = (now) => {
      frames.push(now - last);
      last = now;
      if (raf) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const total = document.documentElement.scrollHeight - innerHeight;
    const t0 = performance.now();
    // ~2200ms constant-velocity programmatic scroll through the whole wall.
    await new Promise((resolve) => {
      const step = (now) => {
        const p = Math.min(1, (now - t0) / 2200);
        scrollTo(0, total * p);
        if (p < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    raf = false;
    const over = frames.filter((f) => f > 33.4);
    return {
      frames: frames.length,
      janky: over.length,
      jankyPct: +((over.length / frames.length) * 100).toFixed(1),
      worstFrame: Math.round(Math.max(...frames)),
    };
  });
}

async function main() {
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
  await page.addInitScript(INIT);

  // Dev sign-in.
  await page.goto(`${base}/signin`);
  await page.getByTestId("dev-email").fill("perf@example.com");
  await page.getByTestId("dev-name").fill("Perf Main");
  await page.getByTestId("dev-signin").click();
  await page.waitForURL(`${base}/`);

  const claimsRes = await page.request.get(`${base}/api/reimbursements`);
  const { reimbursements } = await claimsRes.json();
  const biggest = [...reimbursements].sort(
    (a, b) => (b._count?.lineItems ?? 0) - (a._count?.lineItems ?? 0)
  )[0];

  const report = {};

  // --- Shoebox: 320-card wall -----------------------------------------------
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForSelector('[data-testid^="receipt-card-"]');
  await page.waitForTimeout(3500); // let lazy thumbnails + CLS settle
  report.shoebox = await collect(page);
  report.shoebox.scroll = await scrollJank(page);

  // Interaction: merchant filter chip → next paint.
  await page.evaluate(() => (window.__perf.inp = []));
  const chip = page.getByTestId("receipt-filters").getByRole("radio").nth(2)
    .or(page.getByTestId("receipt-filters").locator("button").nth(2));
  const t0 = Date.now();
  await chip.first().click();
  await page.waitForTimeout(600);
  report.shoebox.filterClick = await page.evaluate(() => {
    const worst = Math.max(0, ...window.__perf.inp.map((e) => e.dur));
    return { worstEventMs: worst };
  });
  report.shoebox.filterClickWallMs = Date.now() - t0;

  // --- Claims list ----------------------------------------------------------
  await page.goto(`${base}/claims`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  report.claims = await collect(page);

  // --- Review screen (biggest claim) ---------------------------------------
  await page.goto(`${base}/claims/${biggest.id}`, { waitUntil: "load" });
  await page.waitForSelector('[data-testid^="row-"]');
  await page.waitForTimeout(3000);
  report.review = await collect(page);
  report.review.scroll = await scrollJank(page);

  // Interaction: toggle a row's exclude button (optimistic PATCH →
  // re-render) — on the biggest DRAFT claim; frozen rows are read-only.
  const draft = [...reimbursements]
    .filter((r) => r.status === "draft")
    .sort((a, b) => (b._count?.lineItems ?? 0) - (a._count?.lineItems ?? 0))[0];
  await page.goto(`${base}/claims/${draft.id}`, { waitUntil: "load" });
  await page.waitForSelector('[data-testid^="exclude-"]');
  await page.evaluate(() => (window.__perf.inp = []));
  const excludeBtn = page.locator('[data-testid^="exclude-"]').first();
  await excludeBtn.click();
  await page.waitForTimeout(600);
  report.review.excludeClick = await page.evaluate(() => ({
    worstEventMs: Math.max(0, ...window.__perf.inp.map((e) => e.dur)),
  }));

  // --- Search screen --------------------------------------------------------
  await page.goto(`${base}/search`, { waitUntil: "load" });
  await page.waitForTimeout(800);
  await page.getByTestId("search-input").fill("retreat snacks");
  await page.getByTestId("search-submit").click();
  await page.waitForTimeout(2500);
  report.search = await collect(page);

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
