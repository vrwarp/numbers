import { test, expect } from "@playwright/test";
import { makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

test("unauthenticated visitors are redirected to sign-in and APIs return 401", async ({ page }) => {
  await page.goto("/");
  await page.waitForURL(/\/signin/);
  // The legacy /shoebox path redirects home, which redirects to sign-in.
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
  await alice.goto("/");
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
  expect(
    (await bob.request.post(`/api/receipts/${receiptId}/edit`, { data: { rotate: 90 } })).status()
  ).toBe(404);
  expect((await bob.request.post(`/api/reimbursements/${claimId}/pdf`)).status()).toBe(404);
  expect(
    (await bob.request.delete(`/api/reimbursements/${claimId}/receipts/${receiptId}`)).status()
  ).toBe(404);
  expect(
    (
      await bob.request.post(`/api/reimbursements/${claimId}/receipts`, {
        data: { receiptIds: [receiptId] },
      })
    ).status()
  ).toBe(404);
  expect((await bob.request.post(`/api/reimbursements/${claimId}/revert`)).status()).toBe(404);
  // Bob cannot build a claim from Alice's receipt either.
  expect((await bob.request.post("/api/reimbursements", { data: { receiptIds: [receiptId] } })).status()).toBe(404);
});

test("shoebox housekeeping: deleting receipts and discarding drafts", async ({ page }, testInfo) => {
  page.on("dialog", (d) => d.accept());
  await signInAs(page, `keeper-${testInfo.project.name}@example.com`, "Keeper");
  await page.goto("/");
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
  await page.waitForURL("/");
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
  await page.goto("/");
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

test("receipt notes are visible everywhere and receipts can go on multiple claims", async ({ page }, testInfo) => {
  await signInAs(page, `reuse-${testInfo.project.name}@example.com`, "Reuser");

  // Upload happens immediately; the describe dialog then shows the uploaded
  // receipt's PREVIEW next to the description field. (Driven manually here
  // instead of via the helper to also assert the dialog and screenshot it.)
  await page.getByTestId("file-input").setInputFiles([await makeReceiptFixture("note-me.jpg")]);
  await expect(page.locator('[data-testid^="receipt-card-"]')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId("upload-note")).toBeVisible();
  await expect(page.getByTestId("upload-preview").locator("img")).toBeVisible();

  // The rotate/crop editor is available right in the describe step.
  await page.locator('[data-testid^="edit-image-"]').click();
  await expect(page.getByTestId("image-editor-stage")).toBeVisible();
  await page.getByTestId("rotate-right").click();
  await page.getByTestId("image-editor-save").click();
  await expect(page.getByTestId("image-editor-stage")).toBeHidden();
  await expect(page.getByTestId("upload-preview").locator("img")).toBeVisible();

  await page.getByTestId("upload-note").fill("VBS craft supplies");
  await page.screenshot({ path: "screenshots/10-upload-dialog.png" });
  await page.getByTestId("upload-note-confirm").click();
  await expect(page.getByTestId("upload-note")).toBeHidden(); // queue drained
  const noteInput = page.locator('[data-testid^="receipt-note-"]');
  await expect(noteInput).toHaveValue("VBS craft supplies");

  // The note is editable from the card.
  await noteInput.fill("VBS craft supplies (June)");
  await noteInput.blur();
  await expect(page.locator('[data-testid^="receipt-note-"]')).toHaveValue(
    "VBS craft supplies (June)"
  );

  // Claim 1: the note travels to the review screen.
  await page.locator('[data-testid^="receipt-card-"]').first().click();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });
  const claim1 = page.url().match(/claims\/([^/]+)/)![1];
  await expect(page.getByText("VBS craft supplies (June)").first()).toBeVisible();

  // Verify + generate via API.
  const item1 = (await (await page.request.get(`/api/reimbursements/${claim1}`)).json())
    .reimbursement.lineItems[0];
  await page.request.patch(`/api/line-items/${item1.id}`, {
    data: { ministry: "General Fund", isVerified: true },
  });
  expect((await page.request.post(`/api/reimbursements/${claim1}/pdf`)).status()).toBe(200);

  // The processed receipt can go on a SECOND claim (e.g. the purchase is
  // split across two filings).
  const receipt = (await (await page.request.get("/api/receipts")).json()).receipts[0];
  expect(receipt.status).toBe("processed");
  expect(receipt.claims).toHaveLength(1); // link data for the shoebox card
  const res2 = await page.request.post("/api/reimbursements", {
    data: { receiptIds: [receipt.id] },
  });
  expect(res2.status()).toBe(201);
  const claim2 = (await res2.json()).reimbursement.id;

  // The shoebox card links to both claims.
  await page.goto("/");
  await expect(page.locator(`[data-testid^="claim-link-${receipt.id}-"]`)).toHaveCount(2);

  // Generate claim 2, then revert claim 1: the receipt stays processed
  // because claim 2 (generated) still holds it; reverting claim 2 releases it.
  const item2 = (await (await page.request.get(`/api/reimbursements/${claim2}`)).json())
    .reimbursement.lineItems[0];
  await page.request.patch(`/api/line-items/${item2.id}`, {
    data: { ministry: "Footprints", isVerified: true },
  });
  expect((await page.request.post(`/api/reimbursements/${claim2}/pdf`)).status()).toBe(200);
  expect((await page.request.post(`/api/reimbursements/${claim1}/revert`)).status()).toBe(200);
  let status = (await (await page.request.get("/api/receipts")).json()).receipts[0].status;
  expect(status).toBe("processed");
  expect((await page.request.post(`/api/reimbursements/${claim2}/revert`)).status()).toBe(200);
  status = (await (await page.request.get("/api/receipts")).json()).receipts[0].status;
  expect(status).toBe("unassigned");
});

test("revert to draft unfreezes a generated claim and its receipts", async ({ page }, testInfo) => {
  page.on("dialog", (d) => d.accept());
  await signInAs(page, `reverter-${testInfo.project.name}@example.com`, "Reverter");
  await page.goto("/");
  await uploadReceipts(page, [await makeReceiptFixture("revert-me.jpg")]);
  await page.locator('[data-testid^="receipt-card-"]').first().click();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });
  const claimId = page.url().match(/claims\/([^/]+)/)![1];

  // Reverting a draft is refused — only generated claims revert.
  expect((await page.request.post(`/api/reimbursements/${claimId}/revert`)).status()).toBe(409);

  // Verify the single row and generate the PDF via the API.
  const item = (await (await page.request.get(`/api/reimbursements/${claimId}`)).json())
    .reimbursement.lineItems[0];
  expect(
    (
      await page.request.patch(`/api/line-items/${item.id}`, {
        data: { ministry: "General Fund", isVerified: true },
      })
    ).status()
  ).toBe(200);
  expect((await page.request.post(`/api/reimbursements/${claimId}/pdf`)).status()).toBe(200);

  // Generated: frozen rows, processed receipt.
  expect(
    (await page.request.patch(`/api/line-items/${item.id}`, { data: { amountCents: 1 } })).status()
  ).toBe(409);

  // Revert through the UI.
  await page.goto(`/claims/${claimId}`);
  await expect(page.getByTestId("claim-status")).toHaveText("Generated");
  await page.getByTestId("revert-claim").click();
  await expect(page.getByTestId("claim-status")).toHaveText("Draft");

  // Receipt is back to unassigned; rows are editable again (edit revokes the
  // checkmark as usual), and the revert left an audit trail.
  const receipts = (await (await page.request.get("/api/receipts")).json()).receipts;
  expect(receipts.every((r: { status: string }) => r.status === "unassigned")).toBe(true);
  expect(
    (
      await page.request.patch(`/api/line-items/${item.id}`, {
        data: { description: "edited after revert" },
      })
    ).status()
  ).toBe(200);
  const { logs } = await (
    await page.request.get(`/api/extraction-logs?reimbursementId=${claimId}`)
  ).json();
  const detail = await (await page.request.get(`/api/extraction-logs/${logs[0].id}`)).json();
  expect(detail.auditEvents.map((e: { action: string }) => e.action)).toContain("revert-to-draft");

  // The round trip completes: re-verify and regenerate.
  expect(
    (await page.request.patch(`/api/line-items/${item.id}`, { data: { isVerified: true } })).status()
  ).toBe(200);
  expect((await page.request.post(`/api/reimbursements/${claimId}/pdf`)).status()).toBe(200);
});

test("PDF endpoint refuses while any active row is unverified", async ({ page }, testInfo) => {
  await signInAs(page, `strict-${testInfo.project.name}@example.com`, "Strict");
  await page.goto("/");
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
