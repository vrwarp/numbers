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

/**
 * A server-guarded page bounces an unauthorized caller home. Next streams the
 * server `redirect("/")` as a client-side redirect, which WebKit reports as the
 * goto navigation being "interrupted by another navigation" — waiting only for
 * "commit" lets the goto resolve before that redirect fires, so we then assert
 * on the landing URL. (Chromium tolerates the interrupt; WebKit does not.)
 */
async function expectBounceHome(page: import("@playwright/test").Page, dest: string) {
  await page.goto(dest, { waitUntil: "commit" });
  await page.waitForURL("/");
}

test("a member cannot see or reach the admin area", async ({ page }) => {
  await signInAs(page, "plain-member@example.org", "Plain Member");
  // Admin lives on the /manage hub now; a member has neither the Manage nav tab
  // nor access to the hub or the admin page.
  await expect(page.getByTestId("nav-tab-manage")).toHaveCount(0);
  // Direct navigation is bounced home (the pages redirect; the APIs 404).
  await expectBounceHome(page, "/manage");
  await expectBounceHome(page, "/admin");
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

  // Admin duty paused: isAppAdmin fails, so /admin bounces and its APIs 404. The
  // Manage tab itself stays (approvals/finance duties still grant the other
  // tools), but the Admin card is gone from the hub.
  await page.reload();
  await page.goto("/manage");
  await expect(page.getByTestId("manage-admin")).toHaveCount(0);
  await expectBounceHome(page, "/admin");
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
  // Reset the pause flags too: a retried run reuses this per-project user, so a
  // prior attempt that left it paused (below) must not bleed into a fresh start.
  await setState({ role: "treasurer", approvalsPaused: false, financePaused: false });

  // Un-paused: the Manage hub carries the master-data trio.
  await page.reload();
  await expect(page.getByTestId("nav-tab-manage")).toBeVisible();
  await page.goto("/manage");
  await expect(page.getByTestId("manage-budget-categories")).toBeVisible();
  await expect(page.getByTestId("manage-positions")).toBeVisible();
  await expect(page.getByTestId("manage-members")).toBeVisible();

  // Step back from every duty a treasurer holds (approvals + finance) — the
  // A10 "fully paused reads like a member" state, same as the search grant.
  await setState({ approvalsPaused: true, financePaused: true });

  // Manage entry gone, hub + pages bounce home, APIs 404 — a member's view.
  await page.reload();
  await expect(page.getByTestId("nav-tab-manage")).toHaveCount(0);
  for (const dest of ["/manage", "/ministries", "/positions", "/members"]) {
    await expectBounceHome(page, dest);
  }
  expect((await page.request.get("/api/ministries?scope=all")).status()).toBe(404);
  expect((await page.request.get("/api/positions")).status()).toBe(404);
  expect((await page.request.get("/api/members")).status()).toBe(404);

  // Un-pausing a single duty restores the whole cluster (any active duty).
  await setState({ financePaused: false });
  await page.reload();
  await expect(page.getByTestId("nav-tab-manage")).toBeVisible();
  await page.goto("/manage");
  await expect(page.getByTestId("manage-members")).toBeVisible();
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

  // Admin is reached via the Manage nav tab → the hub's Admin card.
  await page.reload();
  await page.getByTestId("nav-tab-manage").click();
  await expect(page.getByTestId("manage-hub")).toBeVisible();
  await page.getByTestId("manage-admin").click();

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
