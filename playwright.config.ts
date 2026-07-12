import { defineConfig, devices, type Project } from "@playwright/test";

/**
 * E2E tests run against a production build with an isolated database and
 * upload directory (.e2e-data), the passwordless dev login enabled, and the
 * AI extraction mocked (deterministic, no network).
 *
 * Matrix: (desktop, mobile) x (chromium, webkit). Desktop projects run the
 * full journey/security suites; mobile projects run the phone-sized capture
 * flow. Limit engines with E2E_BROWSERS=chromium (e.g. where WebKit isn't
 * installed); CI runs both.
 */

const enabledEngines = (process.env.E2E_BROWSERS ?? "chromium,webkit")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// A sandbox may provide its own Chromium instead of the Playwright download.
const chromiumLaunch = process.env.PLAYWRIGHT_CHROMIUM_PATH
  ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
  : {};

const allProjects: (Project & { engine: string })[] = [
  {
    name: "chromium-desktop",
    engine: "chromium",
    use: { ...devices["Desktop Chrome"], ...chromiumLaunch },
    testIgnore: /mobile\.spec\.ts/,
  },
  {
    name: "chromium-mobile",
    engine: "chromium",
    use: { ...devices["Pixel 7"], ...chromiumLaunch },
    testMatch: /mobile\.spec\.ts/,
  },
  {
    name: "webkit-desktop",
    engine: "webkit",
    use: { ...devices["Desktop Safari"] },
    testIgnore: /mobile\.spec\.ts/,
  },
  {
    name: "webkit-mobile",
    engine: "webkit",
    use: { ...devices["iPhone 14"] },
    testMatch: /mobile\.spec\.ts/,
  },
];

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1, // shared SQLite db — keep runs deterministic
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3100",
    // The suites assert English text; pin the browser locale so Accept-Language
    // negotiation always resolves to en regardless of the host machine.
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: allProjects
    .filter((p) => enabledEngines.includes(p.engine))
    .map(({ engine: _engine, ...project }) => project),
  webServer: {
    command: "bash tests/e2e/start-server.sh",
    url: "http://localhost:3100/signin",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
  },
});
