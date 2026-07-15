import { test, expect } from "@playwright/test";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { signInAs } from "./helpers";

/**
 * Admin area (docs/ADMIN.md): the role gate and the main job — editing the
 * church context document. Admin is User.role === "admin" (the verified
 * roster mirror); a member never sees the surface at all. The e2e server runs
 * on the .e2e-data database, so we promote the signed-in user by writing that
 * DB directly (the roster bootstrap that normally grants admin is out of scope
 * here).
 */

function e2ePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: `file:${path.resolve("./.e2e-data/numbers.db")}` } },
  });
}

test("a member cannot see or reach the admin area", async ({ page }) => {
  await signInAs(page, "plain-member@example.org", "Plain Member");
  // Admin lives in the account menu now; a member has no such entry there.
  await page.getByTestId("account-menu").click();
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Direct navigation is bounced home (the page redirects; the API 404s).
  await page.goto("/admin");
  await page.waitForURL("/");
  await expect(page.getByRole("heading", { name: "Receipts" })).toBeVisible();
});

test("an admin edits and saves the church context", async ({ page }) => {
  const email = "church-admin@example.org";
  await signInAs(page, email, "Church Admin");

  const prisma = e2ePrisma();
  try {
    await prisma.user.update({ where: { email }, data: { role: "admin" } });
  } finally {
    await prisma.$disconnect();
  }

  // The admin entry appears in the account menu once the role is in place.
  await page.reload();
  await page.getByTestId("account-menu").click();
  const adminLink = page.getByRole("link", { name: "Admin" });
  await expect(adminLink).toBeVisible();
  await adminLink.click();

  await expect(page.getByTestId("admin-dashboard")).toBeVisible();

  // Overview renders its server-computed health panel.
  await expect(page.getByTestId("health-panel")).toBeVisible();

  // Church Context is the main job.
  await page.getByTestId("admin-tab-context").click();
  const editor = page.getByTestId("context-editor");
  await expect(editor).toBeVisible();
  await editor.fill("# Vocabulary\n- the retreat = Summer Retreat\n");
  await page.getByTestId("context-save").click();
  await expect(page.getByTestId("context-saved")).toBeVisible();

  // Reloading the tab shows the persisted content.
  await page.reload();
  await page.getByTestId("admin-tab-context").click();
  await expect(page.getByTestId("context-editor")).toHaveValue(/Summer Retreat/);
});
