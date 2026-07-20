import { test, expect, type Page } from "@playwright/test";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { signInAs } from "./helpers";

/**
 * Admin setup wizards (docs/ADMIN.md): the launcher lists a guided wizard per
 * optional service, and each testable step runs a server-side dry run. The
 * e2e server runs with the mock flags (AI_MOCK / PUSH_MOCK) and a live mock
 * embedding endpoint, so every wizard's Test resolves deterministically.
 */

function e2ePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: `file:${path.resolve("./.e2e-data/numbers.db")}` } },
  });
}

async function signInAsAdmin(page: Page, email: string): Promise<void> {
  await signInAs(page, email, "Wizard Admin");
  const prisma = e2ePrisma();
  try {
    await prisma.user.update({ where: { email }, data: { role: "admin" } });
  } finally {
    await prisma.$disconnect();
  }
}

function adminEmail(testInfo: { project: { name: string }; retry: number }): string {
  return `wizard-admin-${testInfo.project.name}-r${testInfo.retry}@example.org`;
}

test("the Setup tab lists a wizard for every service", async ({ page }, testInfo) => {
  await signInAsAdmin(page, adminEmail(testInfo));
  await page.goto("/admin");
  await page.getByTestId("admin-tab-setup").click();
  await expect(page.getByTestId("setup-tab")).toBeVisible();
  for (const service of ["push", "ai", "firebase", "search"]) {
    await expect(page.getByTestId(`wizard-card-${service}`)).toBeVisible();
    await expect(page.getByTestId(`wizard-launch-${service}`)).toBeVisible();
  }
});

test("push wizard: walk every step, each test passes, finish", async ({ page }, testInfo) => {
  await signInAsAdmin(page, adminEmail(testInfo));
  await page.goto("/admin");
  await page.getByTestId("admin-tab-setup").click();
  await page.getByTestId("wizard-launch-push").click();
  await expect(page.getByTestId("wizard-push")).toBeVisible();

  // Step 1 (keys) — dry run resolves to the mock check.
  await expect(page.getByTestId("wizard-progress")).toHaveText(/1.*3/);
  await page.getByTestId("wizard-test").click();
  await expect(page.getByTestId("wizard-checks")).toBeVisible();
  await expect(page.getByTestId("wizard-check").first()).toHaveAttribute("data-status", "ok");
  await page.getByTestId("wizard-next").click();

  // Step 2 (service account).
  await expect(page.getByTestId("wizard-progress")).toHaveText(/2.*3/);
  await page.getByTestId("wizard-test").click();
  await expect(page.getByTestId("wizard-check").first()).toHaveAttribute("data-status", "ok");
  await page.getByTestId("wizard-next").click();

  // Step 3 (delivery) — set a valid quiet window, then finish.
  await expect(page.getByTestId("wizard-progress")).toHaveText(/3.*3/);
  await page.getByTestId("cfg-NOTIFY_QUIET").fill("21:30-08:00,sun:09:00-12:30");
  await page.getByTestId("wizard-test").click();
  await expect(page.getByTestId("wizard-check").first()).toHaveAttribute("data-status", "ok");
  await page.getByTestId("wizard-next").click();

  await expect(page.getByTestId("wizard-done")).toBeVisible();
  await page.getByTestId("wizard-finish").click();
  await expect(page.getByTestId("setup-tab")).toBeVisible();

  // The quiet window was actually persisted through the wizard's config save.
  const cfg = await page.request.get("/api/admin/config");
  const fields = ((await cfg.json()) as { fields: { key: string; value: string }[] }).fields;
  expect(fields.find((f) => f.key === "NOTIFY_QUIET")?.value).toContain("21:30-08:00");
});

test("ai wizard: the credentials step tests the provider (mock)", async ({ page }, testInfo) => {
  await signInAsAdmin(page, adminEmail(testInfo));
  await page.goto("/admin");
  await page.getByTestId("admin-tab-setup").click();
  await page.getByTestId("wizard-launch-ai").click();
  await expect(page.getByTestId("wizard-ai")).toBeVisible();

  // Step 1 (provider) has no test — advance.
  await page.getByTestId("wizard-next").click();
  // Step 2 (credentials) — the live dry run, deterministic under AI_MOCK.
  await expect(page.getByTestId("wizard-step-title")).toBeVisible();
  await page.getByTestId("wizard-test").click();
  await expect(page.getByTestId("wizard-checks")).toBeVisible();
  const statuses = await page.getByTestId("wizard-check").evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-status"))
  );
  expect(statuses.length).toBeGreaterThan(0);
  expect(statuses).not.toContain("fail");
});

test("validation API rejects the unauthenticated (401) and non-admins (404)", async ({ page }, testInfo) => {
  // Signed out → 401 (unauthenticated) before any sign-in.
  const anon = await page.request.post("/api/admin/setup/validate", { data: { service: "push" } });
  expect(anon.status()).toBe(401);

  // A signed-in NON-admin is 404 — admin-gated, not just login-gated (the
  // admin surface isn't advertised to ordinary users).
  await signInAs(page, `wizard-member-${testInfo.project.name}-r${testInfo.retry}@example.org`, "Wizard Member");
  const member = await page.request.post("/api/admin/setup/validate", { data: { service: "push", values: {} } });
  expect(member.status()).toBe(404);
});

test("validation API dry-runs each service for an admin", async ({ page }, testInfo) => {
  await signInAsAdmin(page, adminEmail(testInfo));

  // Push (PUSH_MOCK) → the mock check, overall ok.
  const push = await page.request.post("/api/admin/setup/validate", { data: { service: "push", values: {} } });
  expect(push.ok()).toBeTruthy();
  const pushBody = (await push.json()) as { ok: boolean; checks: { code: string }[] };
  expect(pushBody.ok).toBe(true);
  expect(pushBody.checks.some((c) => c.code === "push.mock")).toBe(true);

  // AI (AI_MOCK) → provider + model + mock, overall ok.
  const ai = await page.request.post("/api/admin/setup/validate", { data: { service: "ai", values: {} } });
  const aiBody = (await ai.json()) as { ok: boolean; checks: { code: string }[] };
  expect(aiBody.ok).toBe(true);
  expect(aiBody.checks.some((c) => c.code === "ai.mock")).toBe(true);

  // Search → a real probe against the mock embedding endpoint.
  const search = await page.request.post("/api/admin/setup/validate", { data: { service: "search", values: {} } });
  const searchBody = (await search.json()) as { ok: boolean; checks: { code: string; params?: Record<string, number> }[] };
  const probe = searchBody.checks.find((c) => c.code === "search.probeOk");
  expect(probe, "search probe should reach the mock endpoint").toBeTruthy();
  expect(probe?.params?.dim).toBeGreaterThan(0);

  // Unknown service is rejected.
  const bad = await page.request.post("/api/admin/setup/validate", { data: { service: "nope" } });
  expect(bad.status()).toBe(400);
});
