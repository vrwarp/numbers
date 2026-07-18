import { test, expect } from "@playwright/test";
import { makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

// Mock extraction fixtures (deterministic; see src/lib/ai/mock.ts):
//   costco.jpg        → Costco Wholesale, net $102.10
//   amazon-refund.jpg → Amazon, charged $36.31 − refunded $5.36 = net $30.95
//   costco-return.jpg → pure return, net −$27.98
test("receipts can be added to a draft claim from the review screen", async ({ page }, testInfo) => {
  page.on("dialog", (d) => d.accept());
  await signInAs(page, `adder-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Addy More");

  // One claim from just the Costco receipt; the Amazon one stays in the Shoebox.
  await page.goto("/shoebox");
  await uploadReceipts(page, [
    await makeReceiptFixture("costco.jpg"),
    await makeReceiptFixture("amazon-refund.jpg"),
  ]);
  const receipts = (await (await page.request.get("/api/receipts")).json()).receipts as {
    id: string;
    originalName: string;
  }[];
  const costco = receipts.find((r) => r.originalName === "costco.jpg")!;
  const amazon = receipts.find((r) => r.originalName === "amazon-refund.jpg")!;
  await page.getByTestId(`receipt-card-${costco.id}`).click();
  await expect(page.getByText("1 receipt selected")).toBeVisible();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });
  const claimId = page.url().match(/claims\/([^/]+)/)![1];
  await expect(page.getByTestId("claim-total")).toHaveText("$102.10");

  // Add the forgotten Amazon receipt from the review screen. The dialog only
  // offers receipts that aren't already on the claim.
  await page.getByTestId("add-receipts").click();
  const dialog = page.getByTestId("add-receipts-dialog");
  await expect(dialog.locator(`[data-testid="receipt-card-${costco.id}"]`)).toHaveCount(0);
  await dialog.locator(`[data-testid="receipt-card-${amazon.id}"]`).click();
  await expect(page.getByTestId("add-receipts-confirm")).toHaveText(/Add 1 receipt/);
  await page.getByTestId("add-receipts-confirm").click();

  // The new receipt gets its own card + row and the total updates.
  await expect(page.getByTestId(`group-${amazon.id}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`derivation-${amazon.id}`)).toBeVisible(); // refund derivation note
  await expect(page.getByTestId("claim-total")).toHaveText("$133.05");
  await expect(page.locator('li[data-testid^="row-"]')).toHaveCount(2);

  // A receipt can also be uploaded straight from the dialog (auto-selected).
  await page.getByTestId("add-receipts").click();
  await page
    .getByTestId("add-receipts-file-input")
    .setInputFiles([await makeReceiptFixture("costco-return.jpg", { refund: true })]);
  await expect(page.getByTestId("add-receipts-confirm")).toHaveText(/Add 1 receipt/, {
    timeout: 20_000,
  });
  await page.getByTestId("add-receipts-confirm").click();
  await expect(page.getByTestId("claim-total")).toHaveText("$105.07", { timeout: 30_000 });
  await expect(page.locator('[data-testid^="group-"]')).toHaveCount(3);

  // Added rows behave like created ones: unverified until confirmed…
  await expect(page.getByTestId("verify-progress")).toContainText("0 / 3 verified");

  // …and an added receipt can be removed again (in-app confirm dialog).
  await page.getByTestId(`remove-receipt-${amazon.id}`).click();
  await page.getByTestId("claim-confirm-confirm").click();
  await expect(page.locator('[data-testid^="group-"]')).toHaveCount(2);
  await expect(page.getByTestId("claim-total")).toHaveText("$74.12");

  // Telemetry duty: each add left extraction logs and an add-receipt audit event.
  const { logs } = await (
    await page.request.get(`/api/extraction-logs?reimbursementId=${claimId}`)
  ).json();
  expect(logs).toHaveLength(3); // 1 create + 2 adds
  const detail = await (await page.request.get(`/api/extraction-logs/${logs[0].id}`)).json();
  const actions = detail.auditEvents.map((e: { action: string }) => e.action);
  expect(actions.filter((a: string) => a === "add-receipt")).toHaveLength(2);

  // API guards: re-adding a receipt already on the claim is refused, and the
  // add route rejects a generated claim.
  const dup = await page.request.post(`/api/reimbursements/${claimId}/receipts`, {
    data: { receiptIds: [costco.id] },
  });
  expect(dup.status()).toBe(409);
  const items = (await (await page.request.get(`/api/reimbursements/${claimId}`)).json())
    .reimbursement.lineItems as { id: string }[];
  for (const it of items) {
    await page.request.patch(`/api/line-items/${it.id}`, {
      data: { ministry: "General Fund", isVerified: true },
    });
  }
  expect((await page.request.post(`/api/reimbursements/${claimId}/pdf`)).status()).toBe(200);
  const frozen = await page.request.post(`/api/reimbursements/${claimId}/receipts`, {
    data: { receiptIds: [amazon.id] },
  });
  expect(frozen.status()).toBe(409);
  // The button is gone on a generated claim.
  await page.reload();
  await expect(page.getByTestId("claim-status")).toHaveText("Generated");
  await expect(page.getByTestId("add-receipts")).toHaveCount(0);
});
