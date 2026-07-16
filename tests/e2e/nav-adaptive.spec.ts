import { test, expect } from "@playwright/test";
import { signInAs } from "./helpers";

/**
 * Adaptive nav (overflow + icon compression): with a full attested-treasurer
 * tab set, the row escalates full → icon-only (role tabs only) → overflow as
 * the viewport narrows. Receipts and Claims always keep their labels. Reduced
 * role tabs — whether compressed to an icon in the row or overflowed out of it
 * — are ALSO listed with labels in the ONE account menu (not a second
 * dropdown), and a badge hidden from the row re-surfaces on the avatar. We
 * stub the badges endpoint so all five functional tabs are present regardless
 * of the e-sign backend state.
 */
test("nav keeps Receipts/Claims labels and lists reduced role tabs in the account menu", async ({
  page,
}) => {
  await page.route("**/api/esign/badges", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: true, role: "treasurer", approvals: 2, finance: 3, vouch: true }),
    })
  );

  await signInAs(page, "treasurer-nav@example.org", "Tess Treasurer");

  const receipts = page.getByTestId("nav-tab-shoebox");
  const claims = page.getByTestId("nav-tab-claims");
  const finance = page.getByTestId("nav-tab-finance");
  const vouch = page.getByTestId("nav-tab-vouch");
  const accountMenu = page.getByTestId("account-menu");
  const panel = page.getByTestId("account-menu-panel");

  // Wide: all five tabs in the row with labels; nothing reduced into the menu.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(finance).toBeVisible();
  await expect(vouch.getByText("Vouch", { exact: true })).toBeVisible();
  await expect(receipts.getByText("Receipts", { exact: true })).toBeVisible();
  await expect(page.getByTestId("badge-account")).toHaveCount(0);
  await accountMenu.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Finance", { exact: true })).toHaveCount(0); // not reduced
  await page.keyboard.press("Escape");

  // Phone width: Receipts/Claims keep labels; the reduced role tabs (compressed
  // and/or overflowed) all appear — with labels — in the account menu. Vouch is
  // the lowest priority, so it reduces along with the rest.
  await page.setViewportSize({ width: 380, height: 780 });
  await expect(receipts.getByText("Receipts", { exact: true })).toBeVisible();
  await expect(claims.getByText("Claims", { exact: true })).toBeVisible();
  await accountMenu.click();
  await expect(panel.getByText("Approvals", { exact: true })).toBeVisible();
  await expect(panel.getByText("Finance", { exact: true })).toBeVisible();
  await expect(panel.getByText("Vouch", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // Narrow: the role tabs overflow OUT of the row; the collapsed badge
  // aggregates onto the avatar; they stay reachable in the menu.
  await page.setViewportSize({ width: 330, height: 780 });
  await expect(receipts.getByText("Receipts", { exact: true })).toBeVisible();
  await expect(finance).toHaveCount(0); // gone from the row (menu closed)
  await expect(page.getByTestId("badge-account")).toBeVisible();
  await accountMenu.click();
  await expect(finance).toBeVisible();
  await finance.click();
  await page.waitForURL("**/finance");
});
