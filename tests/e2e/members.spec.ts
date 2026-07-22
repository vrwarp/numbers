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
  // Members lives on the /manage hub now; a member has no Manage nav tab.
  await expect(page.getByTestId("nav-tab-manage")).toHaveCount(0);
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

  // The management trio sits together on the Manage hub.
  await page.reload();
  await page.getByTestId("nav-tab-manage").click();
  await expect(page.getByTestId("manage-budget-categories")).toBeVisible();
  await expect(page.getByTestId("manage-positions")).toBeVisible();
  const membersLink = page.getByTestId("manage-members");
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

test("a custom position carries its own name per language, English as fallback", async ({ page }, testInfo) => {
  const email = `positions-i18n-${testInfo.project.name}@example.org`;
  await signInAs(page, email, "Positions I18n");
  const prisma = e2ePrisma();
  try {
    await prisma.user.update({ where: { email }, data: { role: "treasurer" } });
  } finally {
    await prisma.$disconnect();
  }
  await page.reload();

  // Author a custom role with Simplified + Traditional names of its own.
  await page.goto("/positions");
  await page.getByTestId("add-position").click();
  const card = page.getByTestId("position-card").last();
  await card.getByTestId("position-name").fill("Youth Ministry Deacon");
  await card.getByTestId("position-name-zh-hans").fill("青年事工执事");
  await card.getByTestId("position-name-zh-hant").fill("青年事工執事");
  await page.getByTestId("positions-save").click();
  await page.getByTestId("positions-saved").waitFor();

  const custom = (await (await page.request.get("/api/positions")).json()).positions.find(
    (p: { name: string }) => p.name === "Youth Ministry Deacon"
  );
  expect(custom.nameZhHant).toBe("青年事工執事");

  // The budget-category default-approver picker resolves the custom name to the
  // active locale (its own per-locale string), not the English one.
  const checkedOption = async (loc: string) => {
    await page.context().addCookies([{ name: "numbers_locale", value: loc, url: page.url() }]);
    await page.goto("/ministries");
    const sel = page.getByTestId("ministry-default-position").first();
    await sel.selectOption(custom.id as string);
    return sel.locator("option:checked");
  };
  await expect(await checkedOption("en")).toHaveText("Youth Ministry Deacon");
  await expect(await checkedOption("zh-Hant")).toHaveText("青年事工執事");
  await expect(await checkedOption("zh-Hans")).toHaveText("青年事工执事");
});

test("a position can be deleted, clearing any budget-category default it held", async ({ page }, testInfo) => {
  const email = `positions-delete-${testInfo.project.name}@example.org`;
  await signInAs(page, email, "Positions Delete");
  const prisma = e2ePrisma();
  try {
    await prisma.user.update({ where: { email }, data: { role: "treasurer" } });
  } finally {
    await prisma.$disconnect();
  }
  await page.reload();

  // Create a throwaway custom position (it lands last, by sortOrder).
  await page.goto("/positions");
  await page.getByTestId("add-position").click();
  await page.getByTestId("position-card").last().getByTestId("position-name").fill("Temp Deacon");
  await page.getByTestId("positions-save").click();
  await page.getByTestId("positions-saved").waitFor();
  const tempId = (await (await page.request.get("/api/positions")).json()).positions.find(
    (p: { name: string }) => p.name === "Temp Deacon"
  ).id as string;

  // Point a budget category's default approver at it and persist.
  await page.goto("/ministries");
  await page.getByTestId("ministry-default-position").first().selectOption(tempId);
  await page.getByTestId("ministries-save").click();
  await page.getByTestId("ministries-saved").waitFor();
  const usedBefore = (await (await page.request.get("/api/ministries?scope=all")).json()).rows.filter(
    (m: { defaultPositionId: string | null }) => m.defaultPositionId === tempId
  );
  expect(usedBefore.length).toBe(1);

  // Delete is only offered once the position is archived (a deliberate second
  // step). Archive it, then delete; the confirm names the in-use warning.
  await page.goto("/positions");
  const tempCard = page.getByTestId("position-card").last();
  await expect(tempCard.getByTestId("delete-position")).toHaveCount(0);
  await tempCard.getByTestId("position-active-toggle").click();
  await tempCard.getByTestId("delete-position").click();
  const dialog = page.getByTestId("delete-position-dialog");
  await expect(dialog).toContainText("Temp Deacon");
  await expect(dialog).toContainText("budget categor");
  await page.getByTestId("delete-position-dialog-confirm").click();
  await page.getByTestId("positions-save").click();
  await page.getByTestId("positions-saved").waitFor();

  // Gone from the catalog, and the category default it held was cleared.
  const after = await (await page.request.get("/api/positions")).json();
  expect(after.positions.some((p: { name: string }) => p.name === "Temp Deacon")).toBe(false);
  const stillUsed = (await (await page.request.get("/api/ministries?scope=all")).json()).rows.filter(
    (m: { defaultPositionId: string | null }) => m.defaultPositionId === tempId
  );
  expect(stillUsed.length).toBe(0);
});

test("Load defaults refills a blanked description and stages missing categories", async ({ page }, testInfo) => {
  const email = `ministries-defaults-${testInfo.project.name}@example.org`;
  await signInAs(page, email, "Ministries Defaults");
  const prisma = e2ePrisma();
  try {
    await prisma.user.update({ where: { email }, data: { role: "treasurer" } });
  } finally {
    await prisma.$disconnect();
  }
  await page.reload();

  // Blank the first category's description (rows sort by group, then code, so
  // this is a stable built-in code) and persist the blank.
  await page.goto("/ministries");
  const firstDesc = page.getByTestId("ministry-description").first();
  const original = await firstDesc.inputValue();
  await firstDesc.fill("");
  await page.getByTestId("ministries-save").click();
  await page.getByTestId("ministries-saved").waitFor();

  // Load defaults: the blank comes back filled with the built-in guidance,
  // staged but not saved (the banner says so, and Save shows pending changes).
  await page.getByTestId("load-defaults").click();
  await expect(page.getByTestId("defaults-loaded")).toBeVisible();
  await expect(firstDesc).not.toHaveValue("");
  await page.getByTestId("ministries-save").click();
  await page.getByTestId("ministries-saved").waitFor();

  // A second click has nothing left to stage.
  await page.getByTestId("load-defaults").click();
  await expect(page.getByTestId("defaults-loaded")).toContainText("Nothing to load");

  // Restore the original text so this test leaves the catalog as it found it.
  // (When the catalog was seeded from the defaults, the refill already equals
  // the original and there is nothing to save.)
  if (original && original !== (await firstDesc.inputValue())) {
    await firstDesc.fill(original);
    await page.getByTestId("ministries-save").click();
    await page.getByTestId("ministries-saved").waitFor();
  }
});
