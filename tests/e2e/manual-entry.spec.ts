import { test, expect } from "@playwright/test";
import { completeProfile, makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

// A fixture whose file name contains "unreadable" makes the mock extractor
// throw (see src/lib/ai/mock.ts), standing in for a photo the AI can't read —
// e.g. a book cover, or a legit receipt the model returns null merchant for.

test("a receipt the AI can't read gets a manual-entry dialog instead of blocking the claim", async ({
  page,
}, testInfo) => {
  page.on("dialog", (d) => d.accept());
  await signInAs(page, `manual-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Manny Entry");
  await completeProfile(page);

  await page.goto("/shoebox");
  await uploadReceipts(page, [
    await makeReceiptFixture("costco.jpg"),
    await makeReceiptFixture("unreadable-cover.jpg"),
  ]);
  const receipts = (await (await page.request.get("/api/receipts")).json()).receipts as {
    id: string;
    originalName: string;
  }[];
  const costco = receipts.find((r) => r.originalName === "costco.jpg")!;
  const book = receipts.find((r) => r.originalName === "unreadable-cover.jpg")!;

  // Generate a claim from BOTH receipts — the unreadable one used to fail the
  // whole batch; now it must come through as a manual-entry row.
  await page.getByTestId(`receipt-card-${costco.id}`).click();
  await page.getByTestId(`receipt-card-${book.id}`).click();
  await expect(page.getByText("2 receipts selected")).toBeVisible();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });
  const claimId = page.url().match(/claims\/([^/]+)/)![1];

  // Both receipts are on the claim and the manual-entry dialog auto-opens for
  // the one the AI couldn't read.
  await expect(page.getByTestId(`group-${costco.id}`)).toBeVisible();
  await expect(page.getByTestId(`group-${book.id}`)).toBeVisible();
  await expect(page.getByTestId("manual-entry-dialog")).toBeVisible({ timeout: 15_000 });

  // Fill in the fields the LLM was supposed to extract, then save.
  await page.getByTestId("manual-merchant").fill("Church Bookstore");
  await page.getByTestId("manual-total").fill("12.50");
  await page.getByTestId("manual-summary").fill("I Am Number Four (youth library)");
  await expect(page.getByTestId("manual-net")).toContainText("$12.50");
  await page.getByTestId("manual-save").click();
  await expect(page.getByTestId("manual-entry-dialog")).toBeHidden({ timeout: 15_000 });

  // The row picked up the entered amount and the "couldn't read" banner is gone.
  await expect(page.getByTestId("claim-total")).toHaveText("$114.60");
  await expect(page.getByTestId(`manual-entry-banner-${book.id}`)).toHaveCount(0);

  // The manually-entered row verifies and prints like any other.
  const items = (await (await page.request.get(`/api/reimbursements/${claimId}`)).json())
    .reimbursement.lineItems as { id: string }[];
  for (const it of items) {
    await page.request.patch(`/api/line-items/${it.id}`, {
      data: { ministry: "356 Library - English", isVerified: true },
    });
  }
  expect((await page.request.post(`/api/reimbursements/${claimId}/pdf`)).status()).toBe(200);
});

test("manual mode skips AI entirely and starts every row blank (the rate-limit escape hatch)", async ({
  page,
}, testInfo) => {
  await signInAs(page, `escape-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Esca Patch");

  await page.goto("/shoebox");
  await uploadReceipts(page, [
    await makeReceiptFixture("costco.jpg"),
    await makeReceiptFixture("amazon-refund.jpg"),
  ]);
  const receipts = (await (await page.request.get("/api/receipts")).json()).receipts as {
    id: string;
  }[];
  const ids = receipts.map((r) => r.id);

  // This is exactly what the "Enter manually instead" button posts.
  const res = await page.request.post("/api/reimbursements", {
    data: { receiptIds: ids, manual: true },
  });
  expect(res.status()).toBe(201);
  const claimId = (await res.json()).reimbursement.id as string;

  const claim = (await (await page.request.get(`/api/reimbursements/${claimId}`)).json())
    .reimbursement as {
    totalCents: number;
    lineItems: { id: string; description: string; amountCents: number; originalDescription: string | null }[];
    receipts: { receiptId: string }[];
  };
  expect(claim.lineItems).toHaveLength(2);
  for (const it of claim.lineItems) {
    expect(it.description).toBe("");
    expect(it.amountCents).toBe(0);
    expect(it.originalDescription).toBeNull(); // human-created row
  }
  expect(claim.totalCents).toBe(0);

  // No provider calls were made, so there is no extraction telemetry.
  const { logs } = await (
    await page.request.get(`/api/extraction-logs?reimbursementId=${claimId}`)
  ).json();
  expect(logs).toHaveLength(0);

  // The manual-entry endpoint fills a placeholder like a real extraction would.
  const receiptId = claim.receipts[0].receiptId;
  const fill = await page.request.patch(
    `/api/reimbursements/${claimId}/receipts/${receiptId}`,
    {
      data: {
        merchant: "Costco Wholesale",
        purchaseDate: "2026-06-21",
        totalAmount: 50,
        refundAmount: 0,
        summary: "6ft folding table",
      },
    }
  );
  expect(fill.status()).toBe(200);
  expect((await fill.json()).totalCents).toBe(5000);

  // Filling a receipt that isn't on the claim is a 404 (own-scoped).
  const bogus = await page.request.patch(
    `/api/reimbursements/${claimId}/receipts/does-not-exist`,
    { data: { merchant: "X", purchaseDate: "", totalAmount: 1, refundAmount: 0, summary: "y" } }
  );
  expect(bogus.status()).toBe(404);
});

test("an unreadable receipt added to an existing claim also prompts manual entry", async ({
  page,
}, testInfo) => {
  page.on("dialog", (d) => d.accept());
  await signInAs(page, `addfail-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Adda Fail");

  await page.goto("/shoebox");
  await uploadReceipts(page, [
    await makeReceiptFixture("costco.jpg"),
    await makeReceiptFixture("unreadable-flyer.jpg"),
  ]);
  const receipts = (await (await page.request.get("/api/receipts")).json()).receipts as {
    id: string;
    originalName: string;
  }[];
  const costco = receipts.find((r) => r.originalName === "costco.jpg")!;
  const bad = receipts.find((r) => r.originalName === "unreadable-flyer.jpg")!;

  // A clean claim from just the Costco receipt.
  await page.getByTestId(`receipt-card-${costco.id}`).click();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByTestId("claim-total")).toHaveText("$102.10");

  // Add the unreadable one — the add succeeds and review prompts for its details.
  await page.getByTestId("add-receipts").click();
  await page.getByTestId("add-receipts-dialog").locator(`[data-testid="receipt-card-${bad.id}"]`).click();
  await page.getByTestId("add-receipts-confirm").click();

  await expect(page.getByTestId(`group-${bad.id}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("manual-entry-dialog")).toBeVisible({ timeout: 15_000 });

  // Deferring leaves an editable placeholder row plus a persistent prompt to reopen.
  await page.getByTestId("manual-skip").click();
  await expect(page.getByTestId("manual-entry-dialog")).toBeHidden();
  await expect(page.getByTestId(`manual-entry-banner-${bad.id}`)).toBeVisible();

  // Reopen from the banner and complete it.
  await page.getByTestId(`manual-entry-open-${bad.id}`).click();
  await page.getByTestId("manual-merchant").fill("Office Depot");
  await page.getByTestId("manual-total").fill("8.00");
  await page.getByTestId("manual-summary").fill("Poster board");
  await page.getByTestId("manual-save").click();
  await expect(page.getByTestId("manual-entry-dialog")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("claim-total")).toHaveText("$110.10");
});
