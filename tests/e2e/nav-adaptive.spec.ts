import { test, expect } from "@playwright/test";
import { signInAs } from "./helpers";

/**
 * Adaptive nav (Phase 2 + 3): with a full treasurer tab set, the row escalates
 * full labels → icon-only → overflow "More" as the viewport narrows, and never
 * drops a work badge silently (it re-surfaces on the More trigger). We stub the
 * badges endpoint so the four functional tabs are present regardless of the
 * e-sign backend state in the e2e DB.
 */
test("nav escalates full → icon-only → overflow as width shrinks", async ({ page }) => {
  await page.route("**/api/esign/badges", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: true, role: "treasurer", approvals: 2, finance: 3 }),
    })
  );

  await signInAs(page, "treasurer-nav@example.org", "Tess Treasurer");

  const receipts = page.getByTestId("nav-tab-shoebox");
  const finance = page.getByTestId("nav-tab-finance");
  const more = page.getByTestId("nav-more");

  // Wide: all four tabs visible, no overflow, and Receipts shows its label.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(receipts).toBeVisible();
  await expect(finance).toBeVisible();
  await expect(more).toHaveCount(0);
  await expect(receipts.getByText("Receipts", { exact: true })).toBeVisible();

  // Phone width: still all four (four narrow icon-only tabs fit), and the work
  // badges remain on their own tabs — not hidden.
  await page.setViewportSize({ width: 380, height: 780 });
  await expect(receipts).toBeVisible();
  await expect(finance).toBeVisible();
  await expect(page.getByTestId("badge-approvals")).toBeVisible();
  await expect(page.getByTestId("badge-finance")).toBeVisible();

  // Tiny width forces overflow. The pinned home tab stays; lower-priority tabs
  // collapse into More; a badged tab that collapsed re-surfaces its signal on
  // the trigger (aggregated badge).
  await page.setViewportSize({ width: 240, height: 780 });
  await expect(more).toBeVisible();
  await expect(receipts).toBeVisible();
  await expect(page.getByTestId("badge-more")).toBeVisible();

  // Opening More reveals the collapsed tabs; they're still reachable links.
  await more.click();
  await expect(finance).toBeVisible();
  await finance.click();
  await page.waitForURL("**/finance");
});
