import { test, expect } from "@playwright/test";
import { makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

test("single receipt review page displays simplified layout, row controls, and top suggestions", async ({ page }, testInfo) => {
  await signInAs(
    page,
    `single-rec-${testInfo.project.name}-r${testInfo.retry}@example.com`,
    "Sing Lereceipt"
  );

  // Upload exactly 1 receipt and generate a claim
  await page.goto("/");
  await uploadReceipts(page, [await makeReceiptFixture("single-rec.jpg")]);
  await page.locator('[data-testid^="receipt-card-"]').first().click();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });

  const claimId = page.url().split("/").pop()!;

  // 1. Verify Simplified Layout constraints
  // - Top ClaimMinistryPanel is visible (contains description & suggest button)
  await expect(page.getByTestId("claim-ministry-panel")).toBeVisible();
  // - Switcher is hidden
  await expect(page.getByTestId("claim-mode-single")).toBeHidden();
  await expect(page.getByTestId("claim-mode-multi")).toBeHidden();
  // - Top dropdown and event inputs are hidden
  await expect(page.getByTestId("claim-ministry")).toBeHidden();
  await expect(page.getByTestId("claim-event")).toBeHidden();

  // - Card header (Receipt label and remove button) is hidden
  const removeButtons = page.locator('[data-testid^="remove-receipt-"]');
  await expect(removeButtons).toBeHidden();

  // - Redundant bottom total card is hidden (but claim-total testid exists on the subtotal span)
  await expect(page.locator('.card:has-text("Claim total")')).toBeHidden();
  await expect(page.getByTestId("claim-total")).toContainText("$102.10");

  // - Progress bar in floating action bar is hidden
  await expect(page.getByTestId("verify-progress")).toBeHidden();

  // 2. Row Category selector is active
  const rowId = (await (await page.request.get(`/api/reimbursements/${claimId}`)).json())
    .reimbursement.lineItems[0].id;
  const rowSelect = page.getByTestId(`ministry-${rowId}`);
  await expect(rowSelect).toBeVisible();
  await expect(rowSelect).toBeEnabled();

  // 3. AI Suggestion Flow
  await page.getByTestId("claim-description").fill("Snacks for the youth retreat");
  await page.getByTestId("suggest-ministry").click();
  await expect(page.getByTestId("suggestion-banner")).toContainText(
    "471 Youth Retreat — Youth Retreat"
  );

  // Apply suggestion
  await page.getByTestId("suggestion-apply").click();
  await expect(rowSelect).toHaveValue("471 Youth Retreat");

  // 4. Verification Gate
  const generatePdfBtn = page.getByTestId("generate-pdf");
  // Disabled initially (unverified)
  await expect(generatePdfBtn).toBeDisabled();

  // Verify the row
  await page.getByTestId(`verify-${rowId}`).click();
  await expect(generatePdfBtn).toBeEnabled();

  // 5. Split Behavior (splits immediately without switch-mode dialog)
  await page.getByTestId(`unverify-${rowId}`).click(); // unverify to enable split
  await page.getByTestId(`split-${rowId}`).click();
  // Real split dialog opens immediately (no split-mode-dialog overlay)
  await expect(page.getByTestId("split-mode-dialog")).toBeHidden();
  await expect(page.getByTestId("split-first-amount")).toBeVisible();
  await page.getByTestId("split-cancel").click();
});
