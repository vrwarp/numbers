import { defineConfig, devices } from "@playwright/test";

/**
 * E-sign e2e against the REAL Firestore backend (docs/agent/TESTING.md).
 * Separate from playwright.config.ts on purpose: this suite only makes sense
 * under `firebase emulators:exec --only auth,firestore` (which provides
 * FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST), and its server runs
 * with the e-sign env instead of the mock. Entry points:
 *
 *   npm run test:e2e:esign          # inner command (run under emulators:exec)
 *   npm run test:e2e:esign:docker   # the LetUsMeet-style container (CI)
 */

const chromiumLaunch = process.env.PLAYWRIGHT_CHROMIUM_PATH
  ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
  : {};

export default defineConfig({
  testDir: "tests/esign-e2e",
  outputDir: "test-results-esign",
  fullyParallel: false,
  workers: 1, // one shared SQLite db + one emulator project — strictly serial
  retries: 0, // a serial story — a mid-story retry would replay onto dirty state
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-esign" }]],
  timeout: 120_000,
  use: {
    baseURL: "http://localhost:3101",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...({ viewport: { width: 480, height: 1000 } } as object),
  },
  projects: [
    {
      name: "esign-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 480, height: 1000 }, ...chromiumLaunch },
    },
  ],
  webServer: {
    command: "bash tests/esign-e2e/start-server.sh",
    url: "http://localhost:3101/signin",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000, // may include a cold `next build`
    reuseExistingServer: !process.env.CI,
  },
});
