import { test, expect } from "@playwright/test";
import { signInAs } from "./helpers";

/**
 * Adaptive nav (overflow + icon compression): with a full treasurer tab set,
 * the row escalates full → icon-only (role tabs only) → overflow as the viewport
 * narrows. Receipts and Claims always keep their labels; the role tabs fold into
 * the ONE account menu (not a second dropdown) when room runs out, and a
 * collapsed work badge re-surfaces on the avatar. We stub the badges endpoint so
 * the four functional tabs are present regardless of the e-sign backend state.
 */
test("nav keeps Receipts/Claims labels and overflows role tabs into the account menu", async ({
  page,
}) => {
  await page.route("**/api/esign/badges", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: true, role: "treasurer", approvals: 2, finance: 3 }),
    })
  );

  await signInAs(page, "treasurer-nav@example.org", "Tess Treasurer");

  const receipts = page.getByTestId("nav-tab-shoebox");
  const claims = page.getByTestId("nav-tab-claims");
  const finance = page.getByTestId("nav-tab-finance");
  const accountMenu = page.getByTestId("account-menu");

  // Wide: all four tabs visible with labels, nothing in the account menu.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(finance).toBeVisible();
  await expect(receipts.getByText("Receipts", { exact: true })).toBeVisible();
  await expect(page.getByTestId("badge-account")).toHaveCount(0);

  // Phone width: Receipts and Claims keep their labels no matter what.
  await page.setViewportSize({ width: 380, height: 780 });
  await expect(receipts.getByText("Receipts", { exact: true })).toBeVisible();
  await expect(claims.getByText("Claims", { exact: true })).toBeVisible();

  // Narrow: the role tabs collapse OUT of the row; Receipts/Claims stay labeled;
  // the collapsed work badge aggregates onto the avatar (one dropdown, not two).
  await page.setViewportSize({ width: 330, height: 780 });
  await expect(receipts.getByText("Receipts", { exact: true })).toBeVisible();
  await expect(finance).toHaveCount(0); // folded into the account menu (closed)
  await expect(page.getByTestId("badge-account")).toBeVisible();

  // The overflowed tabs live in the account menu and are still reachable.
  await accountMenu.click();
  await expect(finance).toBeVisible();
  await finance.click();
  await page.waitForURL("**/finance");
});
