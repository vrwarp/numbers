import { test, expect } from "@playwright/test";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { signInAs } from "./helpers";

/**
 * The Members page (/members): the roster/administration directory, gated like
 * Budget Categories and Positions (treasurer/admin). A plain member never sees
 * the surface; a treasurer gets the read-only directory. The e-sign controls
 * (role selects, access grants) need the enrolled roster, which is out of
 * scope here — tests/esign-e2e exercises them.
 */

function e2ePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: `file:${path.resolve("./.e2e-data/numbers.db")}` } },
  });
}

test("a member cannot see or reach the Members page", async ({ page }) => {
  await signInAs(page, "directory-member@example.org", "Directory Member");
  await page.getByTestId("account-menu").click();
  await expect(page.getByTestId("nav-members")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Direct navigation is bounced home (the page redirects; the API 404s).
  await page.goto("/members");
  await page.waitForURL("/");
  const denied = await page.request.get("/api/members");
  expect(denied.status()).toBe(404);
});

test("a treasurer reaches the directory alongside Budget categories and Positions", async ({ page }, testInfo) => {
  // Unique per project — desktop chromium and webkit share one server+db.
  const email = `directory-treasurer-${testInfo.project.name}@example.org`;
  await signInAs(page, email, "Directory Treasurer");
  const prisma = e2ePrisma();
  try {
    await prisma.user.update({ where: { email }, data: { role: "treasurer" } });
  } finally {
    await prisma.$disconnect();
  }

  // The management trio sits together in the account menu.
  await page.reload();
  await page.getByTestId("account-menu").click();
  await expect(page.getByTestId("nav-budget-categories")).toBeVisible();
  await expect(page.getByTestId("nav-positions")).toBeVisible();
  const membersLink = page.getByTestId("nav-members");
  await expect(membersLink).toBeVisible();
  await membersLink.click();

  // The directory lists everyone (the treasurer at least) with sibling links;
  // with e-sign never set up the enrollment chrome stays hidden behind a note.
  await expect(page.getByTestId("members-directory")).toBeVisible();
  await expect(
    page.locator('[data-testid^="member-row-"]', { hasText: email })
  ).toBeVisible();
  await expect(page.getByTestId("members-vouch-link")).toBeVisible();
  await expect(page.getByText("Electronic signing is turned off right now")).toBeVisible();
  await expect(page.locator('[data-testid^="allow-"]')).toHaveCount(0);

  // The Positions page cross-links back to the directory for role grants.
  await page.goto("/positions");
  await expect(page.getByTestId("positions-members-link")).toBeVisible();

  // Seeding the built-in roster renders localizable names + a "Built-in" tag;
  // switching locale re-labels them from the Positions.builtin catalog while the
  // canonical English name persists underneath (usePositionLabel).
  await page.getByTestId("load-default-positions").click();
  const firstCard = page.getByTestId("position-card").first();
  await expect(firstCard.getByText("Chinese Caring Deacon", { exact: true })).toBeVisible();
  await expect(firstCard.getByText("Built-in", { exact: true })).toBeVisible();

  await page.context().addCookies([
    { name: "numbers_locale", value: "zh-Hant", url: page.url() },
  ]);
  await page.goto("/positions");
  await page.getByTestId("load-default-positions").click();
  const zhCard = page.getByTestId("position-card").first();
  await expect(zhCard.getByText("中文部關懷執事", { exact: true })).toBeVisible();
  await expect(zhCard.getByText("Chinese Caring Deacon", { exact: true })).toHaveCount(0);
});
