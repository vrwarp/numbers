import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against a production build with an isolated database and
 * upload directory (.e2e-data), the passwordless dev login enabled, and the
 * AI extraction mocked (deterministic, no network).
 */
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
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Use the environment's pre-installed Chromium when the exact
    // Playwright-pinned build isn't downloaded (e.g. sandboxed CI).
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
  webServer: {
    command: "bash tests/e2e/start-server.sh",
    url: "http://localhost:3100/signin",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
  },
});
