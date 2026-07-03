import { test, expect } from "@playwright/test";
import { makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

test("unauthenticated visitors are redirected to sign-in and APIs return 401", async ({ page }) => {
  await page.goto("/");
  await page.waitForURL(/\/signin/);
  await page.goto("/shoebox");
  await page.waitForURL(/\/signin/);

  for (const path of ["/api/receipts", "/api/reimbursements", "/api/profile"]) {
    const res = await page.request.get(path);
    expect(res.status(), path).toBe(401);
  }
});

test("users cannot see or fetch each other's data (multi-tenant isolation)", async ({ browser }, testInfo) => {
  // Alice uploads a receipt and creates a claim.
  const alice = await (await browser.newContext()).newPage();
  await signInAs(alice, `alice-${testInfo.project.name}@example.com`, "Alice");
  await alice.goto("/shoebox");
  await uploadReceipts(alice, [await makeReceiptFixture("alice-receipt.jpg")]);
  const aliceReceipts = (await (await alice.request.get("/api/receipts")).json()).receipts;
  expect(aliceReceipts).toHaveLength(1);
  const receiptId = aliceReceipts[0].id;
  const claimRes = await alice.request.post("/api/reimbursements", { data: { receiptIds: [receiptId] } });
  expect(claimRes.status()).toBe(201);
  const claimId = (await claimRes.json()).reimbursement.id;

  // Bob sees an empty shoebox and gets 404s for Alice's resources.
  const bob = await (await browser.newContext()).newPage();
  await signInAs(bob, `bob-${testInfo.project.name}@example.com`, "Bob");
  const bobReceipts = (await (await bob.request.get("/api/receipts")).json()).receipts;
  expect(bobReceipts).toHaveLength(0);

  expect((await bob.request.get(`/api/receipts/${receiptId}/file`)).status()).toBe(404);
  expect((await bob.request.get(`/api/reimbursements/${claimId}`)).status()).toBe(404);

  // Extraction logs are tenant-scoped too.
  const aliceLogs = (await (await alice.request.get(`/api/extraction-logs?reimbursementId=${claimId}`)).json()).logs;
  expect(aliceLogs).toHaveLength(1);
  const bobLogs = (await (await bob.request.get(`/api/extraction-logs?reimbursementId=${claimId}`)).json()).logs;
  expect(bobLogs).toHaveLength(0);
  expect((await bob.request.get(`/api/extraction-logs/${aliceLogs[0].id}`)).status()).toBe(404);
  expect((await bob.request.delete(`/api/receipts/${receiptId}`)).status()).toBe(404);
  expect((await bob.request.post(`/api/reimbursements/${claimId}/pdf`)).status()).toBe(404);
  // Bob cannot build a claim from Alice's receipt either.
  expect((await bob.request.post("/api/reimbursements", { data: { receiptIds: [receiptId] } })).status()).toBe(404);
});

test("shoebox housekeeping: deleting receipts and discarding drafts", async ({ page }, testInfo) => {
  page.on("dialog", (d) => d.accept());
  await signInAs(page, `keeper-${testInfo.project.name}@example.com`, "Keeper");
  await page.goto("/shoebox");
  await uploadReceipts(page, [
    await makeReceiptFixture("keep-1.jpg"),
    await makeReceiptFixture("keep-2.jpg"),
  ]);

  // Delete one receipt outright.
  const cards = page.locator('[data-testid^="receipt-card-"]');
  await cards.first().getByRole("button", { name: /Delete/ }).click();
  await expect(cards).toHaveCount(1);

  // Build a draft from the survivor, then discard it — the receipt returns.
  await cards.first().click();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });
  await page.getByTestId("discard-claim").click();
  await page.waitForURL(/\/shoebox/);
  await expect(page.locator('[data-testid^="receipt-card-"]')).toHaveCount(1);

  // A receipt inside a draft claim cannot be deleted.
  await page.locator('[data-testid^="receipt-card-"]').first().click();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });
  const receipts = (await (await page.request.get("/api/receipts")).json()).receipts;
  const res = await page.request.delete(`/api/receipts/${receipts[0].id}`);
  expect(res.status()).toBe(409);
});

test("PDF endpoint refuses while any active row is unverified", async ({ page }, testInfo) => {
  await signInAs(page, `strict-${testInfo.project.name}@example.com`, "Strict");
  await page.goto("/shoebox");
  await uploadReceipts(page, [await makeReceiptFixture("strict.jpg")]);
  await page.locator('[data-testid^="receipt-card-"]').first().click();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });
  const claimId = page.url().match(/claims\/([^/]+)/)![1];

  // Even hitting the API directly (bypassing the disabled button) must fail.
  const res = await page.request.post(`/api/reimbursements/${claimId}/pdf`);
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toMatch(/verification/i);
});
