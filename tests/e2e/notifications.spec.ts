import { test, expect, type Page } from "@playwright/test";
import { signInAs } from "./helpers";

/**
 * Push notifications (docs/NOTIFICATIONS_DESIGN.md), PUSH_MOCK pipeline:
 * enable via the soft-ask (mock token — no browser permission involved),
 * self-test through the REAL worker, activity-list parity, §8.6 sign-out
 * severing, and the §5 empty-state copy. FCM itself is never touched.
 */

function email(testInfo: { project: { name: string }; retry: number }): string {
  return `push-user-${testInfo.project.name}-r${testInfo.retry}@example.com`;
}

async function enablePush(page: Page): Promise<void> {
  await page.goto("/profile");
  await page.getByTestId("notify-enable").click();
  await expect(page.getByTestId("notify-soft-ask")).toBeVisible();
  await page.getByTestId("notify-soft-ask-confirm").click();
  await expect(page.getByTestId("notify-device-off")).toBeVisible();
}

test("enable, self-test through the worker, activity parity, sign-out severs the device", async ({
  page,
}, testInfo) => {
  await signInAs(page, email(testInfo), "Push User");

  // Enable: soft-ask first, then (mock) registration — master + this device.
  await enablePush(page);

  // Category rows render with examples; a plain member sees no signing or
  // finance rows (§8.2: only categories that can ever fire).
  await expect(page.getByTestId("notify-notifyClaimProgress")).toBeVisible();
  await expect(page.getByTestId("notify-notifySecurity")).toBeVisible();
  await expect(page.getByTestId("notify-notifySigning")).toHaveCount(0);
  await expect(page.getByTestId("notify-notifyFinance")).toHaveCount(0);

  // Self-test: an ordinary catalog enqueue the real worker delivers (mock
  // sink); the in-page confirmation is independent of any notification UI.
  await page.getByTestId("notify-self-test").click();
  await expect(page.getByText(/did this device show it\?/)).toBeVisible();

  // §5 parity: the same event appears in the recent-activity page.
  await page.goto("/activity");
  await expect(page.getByTestId("activity-card")).toBeVisible();
  await expect(page.getByTestId("activity-card")).toContainText("test notification");

  // §8.6: sign-out severs this installation — exercised through the same
  // token-DELETE contract signOut() uses.
  await page.goto("/profile");
  const devicesBefore = await page.request.get("/api/notifications/token");
  expect(((await devicesBefore.json()) as { devices: unknown[] }).devices.length).toBe(1);

  await page.evaluate(async () => {
    const token = localStorage.getItem("numbers.push.token");
    await fetch("/api/notifications/token", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  });
  const devicesAfter = await page.request.get("/api/notifications/token");
  expect(((await devicesAfter.json()) as { devices: unknown[] }).devices.length).toBe(0);

  // Master still on + zero devices ⇒ the §8.7 account-level truth banner.
  await page.reload();
  await expect(page.getByText("no device is currently receiving")).toBeVisible();
});

test("token endpoints are owner-scoped and reject garbage", async ({ page }, testInfo) => {
  await signInAs(page, email(testInfo), "Push User");
  const bad = await page.request.post("/api/notifications/token", { data: { token: "x" } });
  expect(bad.status()).toBe(400);
  // A ping (no register) for an unknown token creates nothing.
  const ping = await page.request.post("/api/notifications/token", {
    data: { token: "mock-never-registered-anywhere-123" },
  });
  expect(ping.status()).toBe(200);
  expect(((await ping.json()) as { known: boolean; live: boolean }).known).toBe(false);
  const devices = await page.request.get("/api/notifications/token");
  expect(((await devices.json()) as { devices: unknown[] }).devices.length).toBe(0);
});
