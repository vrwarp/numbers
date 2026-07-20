import { test, expect } from "@playwright/test";
import fs from "fs/promises";
import { signInAs, completeProfile, makeReceiptFixture, makePdfFixture } from "./helpers";

// AI_MOCK fixture math (src/lib/ai/mock.ts):
//   costco.jpg        → Costco Wholesale, net $102.10
//   amazon-refund.jpg → Amazon, net $30.95

test("the receipt wall filters by chips: status, file type, and merchant", async ({ page }, testInfo) => {
  await signInAs(page, `filters-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Filter Fan");
  await completeProfile(page);

  // Upload two photos + one PDF through the API — the wall under test is the
  // list UI, not the upload path.
  const uploads: [string, string, string][] = [
    ["costco.jpg", await makeReceiptFixture("costco.jpg"), "image/jpeg"],
    ["amazon-refund.jpg", await makeReceiptFixture("amazon-refund.jpg"), "image/jpeg"],
    ["invoice.pdf", await makePdfFixture("invoice.pdf"), "application/pdf"],
  ];
  for (const [name, filePath, mimeType] of uploads) {
    const res = await page.request.post("/api/receipts", {
      multipart: { files: { name, mimeType, buffer: await fs.readFile(filePath) } },
    });
    expect(res.status()).toBe(201);
  }

  // Fresh shoebox: everything unassigned, no merchants stamped yet — the only
  // offered narrowing is the PDF chip (status/merchant chips would not narrow).
  await page.goto("/");
  const cards = page.locator('[data-testid^="receipt-card-"]');
  await expect(cards).toHaveCount(3);
  await expect(page.getByTestId("receipt-filter-pdf")).toBeVisible();
  await expect(page.getByTestId("receipt-filter-processed")).toHaveCount(0);

  await page.getByTestId("receipt-filter-pdf").click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("invoice.pdf");
  // Re-tapping the active chip clears it back to All.
  await page.getByTestId("receipt-filter-pdf").click();
  await expect(cards).toHaveCount(3);

  // Claim + generate the two photos so they turn processed and carry their
  // AI-stamped merchants.
  const receipts = (await (await page.request.get("/api/receipts")).json()).receipts as {
    id: string;
    originalName: string;
  }[];
  const photoIds = receipts.filter((r) => r.originalName.endsWith(".jpg")).map((r) => r.id);
  const create = await page.request.post("/api/reimbursements", { data: { receiptIds: photoIds } });
  expect(create.status()).toBe(201);
  const claimId = (await create.json()).reimbursement.id as string;
  const claim = (await (await page.request.get(`/api/reimbursements/${claimId}`)).json())
    .reimbursement;
  for (const item of claim.lineItems) {
    const patch = await page.request.patch(`/api/line-items/${item.id}`, {
      data: { ministry: "General Fund", isVerified: true },
    });
    expect(patch.ok()).toBeTruthy();
  }
  expect((await page.request.post(`/api/reimbursements/${claimId}/pdf`)).status()).toBe(200);

  // The full chip row: the processed chip doubles as the filed-receipts count.
  await page.goto("/");
  await expect(cards).toHaveCount(3);
  await expect(page.getByText("Processed receipts (2)")).toBeVisible();

  await page.getByTestId("receipt-filter-processed").click();
  await expect(cards).toHaveCount(2);
  await expect(page.getByText("Already on a generated claim.")).toBeVisible();

  await page.getByTestId("receipt-filter-unassigned").click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("invoice.pdf");

  // Merchant chips carry the AI-transcribed names verbatim (data, untranslated).
  await page.getByTestId("receipt-filters").getByText("Costco Wholesale", { exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("costco.jpg");
});
