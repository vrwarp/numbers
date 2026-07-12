import { test, expect } from "@playwright/test";
import { signInAs } from "./helpers";

/**
 * Locale switching smoke: cookie-driven language, <html lang>, persistence
 * across reload, and the User.locale round-trip through sign-out/sign-in.
 * The rest of the suite runs pinned to en (playwright.config.ts) — this spec
 * is the one place the Chinese catalogs are exercised end to end.
 */

test("language switcher flips the UI, persists, and follows the account", async ({
  page,
}, testInfo) => {
  const email = `mei-${testInfo.project.name}-r${testInfo.retry}@example.com`;
  await signInAs(page, email, "Mei");

  // Default: English (Accept-Language en-US from the pinned browser locale).
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Shoebox" })).toBeVisible();

  // Switch to Simplified Chinese via the NavBar switcher.
  await page.getByTestId("locale-switcher").selectOption("zh-Hans");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(page.getByRole("heading", { name: "收据盒" })).toBeVisible();

  // Survives a full reload (cookie).
  await page.reload();
  await expect(page.getByRole("heading", { name: "收据盒" })).toBeVisible();

  // Traditional Chinese renders its own catalog, not a conversion.
  await page.getByTestId("locale-switcher").selectOption("zh-Hant");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
  await expect(page.getByRole("heading", { name: "收據盒" })).toBeVisible();

  // The choice was persisted to the profile…
  const profile = await page.request.get("/api/profile").then((r) => r.json());
  expect(profile.user.locale).toBe("zh-Hant");

  // …so after clearing the device cookie, signing in restores it.
  await page.context().clearCookies();
  await page.goto("/signin");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByTestId("dev-email").fill(email);
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("heading", { name: "收據盒" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
});

test("sign-in page offers the switcher before authentication", async ({ page }) => {
  await page.goto("/signin");
  await page.getByTestId("locale-switcher").selectOption("zh-Hans");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  // Tagline from the zh-Hans catalog.
  await expect(page.getByText("CFCC 费用报销", { exact: false })).toBeVisible();
});
