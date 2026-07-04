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
  expect(
    (await bob.request.delete(`/api/reimbursements/${claimId}/receipts/${receiptId}`)).status()
  ).toBe(404);
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

test("removing a receipt from a draft claim returns it to the shoebox", async ({ page }, testInfo) => {
  page.on("dialog", (d) => d.accept());
  await signInAs(page, `remover-${testInfo.project.name}@example.com`, "Remover");
  await page.goto("/shoebox");
  await uploadReceipts(page, [
    await makeReceiptFixture("rm-1.jpg"),
    await makeReceiptFixture("rm-2.jpg"),
  ]);
  for (const card of await page.locator('[data-testid^="receipt-card-"]').all()) await card.click();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });
  const claimId = page.url().match(/claims\/([^/]+)/)![1];

  // Two receipt rows; remove one — its row disappears and the total halves.
  const rows = page.locator('li[data-testid^="row-"]');
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId("claim-total")).toHaveText("$204.20");
  await page.locator('[data-testid^="remove-receipt-"]').first().click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("claim-total")).toHaveText("$102.10");

  // The removed receipt is fully released: deletable again, while the one
  // still in the draft stays delete-blocked.
  const all = (await (await page.request.get("/api/receipts")).json()).receipts;
  const kept = (await (await page.request.get(`/api/reimbursements/${claimId}`)).json())
    .reimbursement.receipts[0].receiptId;
  const removed = all.find((r: { id: string }) => r.id !== kept)!;
  expect((await page.request.delete(`/api/receipts/${removed.id}`)).status()).toBe(200);
  expect((await page.request.delete(`/api/receipts/${kept}`)).status()).toBe(409);

  // Removing the last receipt is refused — discard the claim instead.
  await page.goto(`/claims/${claimId}`);
  const remaining = page.locator('[data-testid^="remove-receipt-"]');
  await expect(remaining).toBeDisabled();
  const res = await page.request.delete(`/api/reimbursements/${claimId}/receipts/${kept}`);
  expect(res.status()).toBe(409);

  // The removal left an audit trail (telemetry duty for mutation routes).
  const { logs } = await (
    await page.request.get(`/api/extraction-logs?reimbursementId=${claimId}`)
  ).json();
  const detail = await (await page.request.get(`/api/extraction-logs/${logs[0].id}`)).json();
  expect(detail.auditEvents.map((e: { action: string }) => e.action)).toContain("remove-receipt");
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
