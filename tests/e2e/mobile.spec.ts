import { test, expect } from "@playwright/test";
import { makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

/** The capture flow is phone-first — make sure it works on a mobile viewport. */
test("phone-sized capture flow: sign in, upload, see the receipt", async ({ page }) => {
  await signInAs(page, "mobile@example.com", "Mobile Mary");
  await page.goto("/shoebox");
  await expect(page.getByTestId("upload-button")).toBeVisible();
  await uploadReceipts(page, [await makeReceiptFixture("mobile.jpg")]);
  await expect(page.locator('[data-testid^="receipt-card-"]')).toHaveCount(1);
  await page.screenshot({ path: "screenshots/09-mobile-shoebox.png", fullPage: true });

  // PWA manifest is wired up.
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBeTruthy();
  expect((await manifest.json()).short_name).toBe("Numbers");
});
