import { test, expect } from "@playwright/test";
import { makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

/** The capture flow is phone-first — make sure it works on a mobile viewport. */
test("phone-sized capture flow: sign in, upload, see the receipt", async ({ page }, testInfo) => {
  await signInAs(page, `mobile-${testInfo.project.name}@example.com`, "Mobile Mary");
  await page.goto("/");
  await expect(page.getByTestId("upload-button")).toBeVisible();
  await uploadReceipts(page, [await makeReceiptFixture("mobile.jpg")]);
  await expect(page.locator('[data-testid^="receipt-card-"]')).toHaveCount(1);
  await page.screenshot({ path: "screenshots/09-mobile-shoebox.png", fullPage: true });

  // PWA manifest is wired up.
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBeTruthy();
  expect((await manifest.json()).short_name).toBe("Numbers");
});

/** Regression test: "the delete button is broken on Safari iOS". The app is a
 *  home-screen PWA (manifest display:standalone), and iOS suppresses native JS
 *  dialogs in standalone web apps — window.confirm() shows nothing and returns
 *  false — so a delete gated on confirm() silently does nothing. Reproduce that
 *  environment by dismissing any native dialog unseen (exactly what iOS does),
 *  and drive the button with a TAP, the gesture an iPhone user actually makes.
 *  Deleting must work through in-app UI instead. */
test("tap-delete works with native confirm() suppressed (iOS standalone)", async ({
  page,
}, testInfo) => {
  const nativeDialogs: string[] = [];
  page.on("dialog", (d) => {
    nativeDialogs.push(d.message());
    void d.dismiss();
  });

  await signInAs(page, `mobile-del-${testInfo.project.name}@example.com`, "Mobile Mary");
  await page.goto("/");
  await uploadReceipts(page, [await makeReceiptFixture("mobile-delete.jpg")]);
  const card = page.locator('[data-testid^="receipt-card-"]');
  await expect(card).toHaveCount(1);

  // Cancel path: the in-app dialog closes and the receipt survives.
  await page.getByRole("button", { name: /^Delete / }).tap();
  await expect(page.getByTestId("delete-receipt-confirm")).toBeVisible();
  await page.getByTestId("delete-receipt-confirm-cancel").tap();
  await expect(page.getByTestId("delete-receipt-confirm")).toHaveCount(0);
  await expect(card).toHaveCount(1);

  // Confirm path: the receipt is deleted.
  await page.getByRole("button", { name: /^Delete / }).tap();
  await page.getByTestId("delete-receipt-confirm-confirm").tap();
  await expect(card).toHaveCount(0, { timeout: 10_000 });

  // The delete tap must not fall through to the card's select toggle, and the
  // flow must never have leaned on a native dialog (invisible on iOS).
  await expect(page.getByTestId("clear-selection")).toHaveCount(0);
  expect(nativeDialogs).toEqual([]);
});
