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

test("a paused admin loses the admin area until they turn the duty back on", async ({ page }, testInfo) => {
  // Unique per project — desktop chromium and webkit share one server+db, and
  // this test flips account state that must not race across projects.
  const email = `duty-admin-${testInfo.project.name}@example.org`;
  await signInAs(page, email, "Duty Admin");
  const prisma = e2ePrisma();
  try {
    await prisma.user.update({ where: { email }, data: { role: "admin" } });
  } finally {
    await prisma.$disconnect();
  }

  // All three duty rows exist for an admin; pause administration.
  await page.goto("/profile");
  await expect(page.getByTestId("duty-approvalsPaused")).toBeVisible();
  await expect(page.getByTestId("duty-financePaused")).toBeVisible();
  await expect(page.getByTestId("duty-adminPaused")).toBeVisible();
  await page.getByTestId("duty-adminPaused-toggle").click();
  await expect(page.getByText("Role controls and admin pages are hidden")).toBeVisible();

  // Nav entry gone, page bounces home, API 404s — same posture as a member.
  await page.reload();
  await page.getByTestId("account-menu").click();
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto("/admin");
  await page.waitForURL("/");
  const denied = await page.request.get("/api/admin/overview");
  expect(denied.status()).toBe(404);
  expect((await page.request.get("/api/admin/extraction-jobs")).status()).toBe(404);
  expect((await page.request.post("/api/admin/extraction-jobs", { data: {} })).status()).toBe(404);

  // The toggle itself is never admin-gated — unpausing restores everything.
  await page.goto("/profile");
  await page.getByTestId("duty-adminPaused-toggle").click();
  await expect(page.getByText("You can change members' roles")).toBeVisible();
  await page.goto("/admin");
  await expect(page.getByTestId("admin-dashboard")).toBeVisible();
});

test("a fully stepped-back treasurer loses the master-data surfaces (Members, Positions, Budget Categories)", async ({
  page,
}, testInfo) => {
  // Unique per project — desktop chromium and webkit share one server+db.
  const email = `duty-treasurer-${testInfo.project.name}@example.org`;
  await signInAs(page, email, "Duty Treasurer");
  async function setState(data: Record<string, unknown>) {
    const prisma = e2ePrisma();
    try {
      await prisma.user.update({ where: { email }, data });
    } finally {
      await prisma.$disconnect();
    }
  }
  await setState({ role: "treasurer" });

  // Un-paused: all three master-data links are present in the account menu.
  await page.reload();
  await page.getByTestId("account-menu").click();
  await expect(page.getByTestId("nav-budget-categories")).toBeVisible();
  await expect(page.getByTestId("nav-positions")).toBeVisible();
  await expect(page.getByTestId("nav-members")).toBeVisible();
  await page.keyboard.press("Escape");

  // Step back from every duty a treasurer holds (approvals + finance) — the
  // A10 "fully paused reads like a member" state, same as the search grant.
  await setState({ approvalsPaused: true, financePaused: true });

  // Nav entries gone, pages bounce home, APIs 404 — a member's view.
  await page.reload();
  await page.getByTestId("account-menu").click();
  await expect(page.getByTestId("nav-budget-categories")).toHaveCount(0);
  await expect(page.getByTestId("nav-positions")).toHaveCount(0);
  await expect(page.getByTestId("nav-members")).toHaveCount(0);
  await page.keyboard.press("Escape");
  for (const dest of ["/ministries", "/positions", "/members"]) {
    await page.goto(dest);
    await page.waitForURL("/");
  }
  expect((await page.request.get("/api/ministries?scope=all")).status()).toBe(404);
  expect((await page.request.get("/api/positions")).status()).toBe(404);
  expect((await page.request.get("/api/members")).status()).toBe(404);

  // Un-pausing a single duty restores the whole cluster (any active duty).
  await setState({ financePaused: false });
  await page.reload();
  await page.getByTestId("account-menu").click();
  await expect(page.getByTestId("nav-members")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto("/members");
  await expect(page.getByTestId("members-directory")).toBeVisible();
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

  // …and the background receipt-reading card: a status line + the four counts
  // (state depends on what earlier specs left queued, so assert presence).
  await expect(page.getByTestId("annotation-queue")).toBeVisible();
  await expect(page.getByTestId("annotation-queue-status")).toBeVisible();
  await expect(page.getByTestId("annotation-stat-failed")).toBeVisible();

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
