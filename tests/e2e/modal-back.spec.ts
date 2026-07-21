import { test, expect } from "@playwright/test";
import { makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

// The browser/OS back gesture dismisses an open modal (via useModalDismiss →
// useBackDismiss) instead of navigating away — the same interaction the
// full-screen ReceiptViewer already got.
test("browser back closes an open confirm dialog without acting or leaving the page", async ({
  page,
}, testInfo) => {
  await signInAs(page, `modal-back-${testInfo.project.name}@example.com`, "Modal Tester");
  await page.goto("/");
  await uploadReceipts(page, [await makeReceiptFixture("costco.jpg")]);

  const card = page.locator('[data-testid^="receipt-card-"]').first();
  await expect(card).toBeVisible();
  // The 🗑 button opens the delete confirmation (a root ConfirmDialog).
  await card.getByRole("button", { name: /delete/i }).click();
  await expect(page.getByTestId("delete-receipt-confirm")).toBeVisible();

  await page.goBack();
  // Dialog dismissed, nothing deleted, still on the receipts page.
  await expect(page.getByTestId("delete-receipt-confirm")).toHaveCount(0);
  await expect(card).toBeVisible();
});

// Stacked overlays peel off one back gesture at a time (LIFO): inside the
// viewer, back closes the image editor first, then the viewer.
test("browser back unwinds the viewer's nested editor one level at a time", async ({
  page,
}, testInfo) => {
  await signInAs(page, `modal-stack-${testInfo.project.name}@example.com`, "Stack Tester");
  await page.goto("/");
  await uploadReceipts(page, [await makeReceiptFixture("edit-me.jpg")]);

  await page.locator('[data-testid^="receipt-view-"]').first().click();
  const viewer = page.getByTestId("receipt-viewer");
  await expect(viewer).toBeVisible();

  // Open the rotate/crop editor on top of the viewer.
  await page.getByTestId("receipt-viewer-edit").click();
  await expect(page.getByTestId("image-editor-stage")).toBeVisible();

  // First back closes the editor but leaves the viewer open.
  await page.goBack();
  await expect(page.getByTestId("image-editor-stage")).toHaveCount(0);
  await expect(viewer).toBeVisible();

  // Second back closes the viewer.
  await page.goBack();
  await expect(viewer).toHaveCount(0);
  await expect(page.locator('[data-testid^="receipt-view-"]').first()).toBeVisible();
});
