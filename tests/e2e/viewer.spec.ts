import { test, expect } from "@playwright/test";
import { makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

// The zoomable full-screen receipt viewer, opened from each Shoebox card.
test("receipt viewer opens, zooms, and closes without selecting the card", async ({
  page,
}, testInfo) => {
  page.on("dialog", (d) => d.accept());
  await page.goto("/signin");
  await signInAs(page, `viewer-${testInfo.project.name}@example.com`, "Zoom Tester");

  await page.goto("/shoebox");
  await uploadReceipts(page, [await makeReceiptFixture("costco.jpg")]);

  // The expand button sits in the bottom-right of the thumbnail.
  const viewBtn = page.locator('[data-testid^="receipt-view-"]').first();
  await expect(viewBtn).toBeVisible();
  await viewBtn.click();

  const viewer = page.getByTestId("receipt-viewer");
  await expect(viewer).toBeVisible();
  await expect(page.getByText("100%")).toBeVisible();

  // Zoom in twice (1.4x each) → 196%.
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  await zoomIn.click();
  await zoomIn.click();
  await expect(page.getByText("196%")).toBeVisible();

  // Reset returns to 100%.
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await expect(page.getByText("100%")).toBeVisible();

  await page.getByTestId("receipt-viewer-close").click();
  await expect(viewer).toHaveCount(0);

  // Opening the viewer must not have toggled the card's selection.
  await expect(page.getByText(/receipt.*selected/i)).toHaveCount(0);
});
