import { test, expect, Page } from "@playwright/test";
import fs from "fs/promises";
import { PDFDocument } from "pdf-lib";
import { makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

const SHOTS = "screenshots";

test.beforeAll(async () => {
  await fs.mkdir(SHOTS, { recursive: true });
});

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test("complete reimbursement journey: capture → batch → verify → PDF", async ({ page }, testInfo) => {
  page.on("dialog", (d) => d.accept());

  // --- Phase 0: sign in & profile ---
  await page.goto("/signin");
  await shot(page, "01-signin");
  await signInAs(page, `grace-${testInfo.project.name}@example.com`, "Grace Chen");
  await shot(page, "02-dashboard");

  await page.goto("/profile");
  await page.getByTestId("profile-name").fill("Grace Chen");
  await page.getByTestId("profile-address").fill("123 Main St, San Jose, CA 95110");
  await page.getByTestId("profile-save").click();
  await expect(page.getByText("Saved ✓")).toBeVisible();
  await shot(page, "03-profile");

  // --- Phase 1: the Shoebox (capture) ---
  await page.goto("/shoebox");
  const purchase = await makeReceiptFixture("costco.jpg");
  const refund = await makeReceiptFixture("costco-refund.jpg", { refund: true });
  await uploadReceipts(page, [purchase, refund]);
  await shot(page, "04-shoebox-uploaded");

  // Compression: stored files should be small (~100 KB budget).
  const receiptsJson = await (await page.request.get("/api/receipts")).json();
  expect(receiptsJson.receipts).toHaveLength(2);
  for (const r of receiptsJson.receipts) {
    expect(r.sizeBytes).toBeLessThan(120 * 1024);
    expect(r.mimeType).toBe("image/jpeg");
  }

  // --- Phase 2: batch & generate ---
  for (const card of await page.locator('[data-testid^="receipt-card-"]').all()) {
    await card.click();
  }
  await expect(page.getByText("2 receipts selected")).toBeVisible();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });

  // --- Phase 3: review & validate ---
  await expect(page.getByTestId("claim-status")).toHaveText("Draft");
  const rows = page.locator('li[data-testid^="row-"]');
  await expect(rows).toHaveCount(6); // 4 purchase items + 2 refund items
  await expect(page.getByText("REFUND", { exact: true })).toHaveCount(2);
  await shot(page, "05-review-initial");

  // Per-receipt subtotals match the printed receipt totals; negative in red.
  await expect(page.getByText("Subtotal: $102.10")).toBeVisible();
  await expect(page.getByText("Subtotal: -$30.57")).toBeVisible();
  await expect(page.getByTestId("claim-total")).toHaveText("$71.53");

  // The PDF button stays locked until every row is verified.
  await expect(page.getByTestId("generate-pdf")).toBeDisabled();

  // Descriptions render as <input> values, so match rows by data attribute.
  // Exact match matters: the refund group renders first and contains
  // near-duplicate descriptions like "Sales Tax (Refund)".
  const rowByDesc = (desc: string) =>
    page.locator(`li[data-testid^="row-"][data-description="${desc}"]`);

  // Exclude the personal snack item — struck out and removed from totals.
  const snackRow = rowByDesc("SNACK VARIETY PACK");
  await snackRow.getByTitle("Exclude item (personal / not reimbursable)").click();
  await expect(page.getByText("Subtotal: $86.61")).toBeVisible();
  await expect(page.getByTestId("claim-total")).toHaveText("$56.04");

  // Adjust the tax row to compensate for the excluded item.
  const taxRow = rowByDesc("Sales Tax");
  await taxRow.getByLabel("Amount").fill("7.25");
  await taxRow.getByLabel("Amount").blur();
  await expect(page.getByTestId("claim-total")).toHaveText("$54.65");

  // Split the folding table between two ministries.
  const tableRow = rowByDesc("FOLDING TABLE 6FT").first();
  await tableRow.getByTitle("Split into two rows").click();
  await page.getByTestId("split-first-amount").fill("25.00");
  await page.getByTestId("split-confirm").click();
  await expect(rows).toHaveCount(7);
  const tableRows = rowByDesc("FOLDING TABLE 6FT");
  await expect(tableRows).toHaveCount(2);
  await expect(page.getByTestId("claim-total")).toHaveText("$54.65"); // split conserves the total
  // Assign the second half to a different ministry.
  await tableRows.nth(1).getByLabel("Ministry").selectOption("Footprints");

  // Verify every active row; the button unlocks only at 6/6.
  await expect(page.getByTestId("verify-progress")).toContainText("0 / 6 verified");
  const approveButtons = page.getByRole("button", { name: "Approve row" });
  await expect(approveButtons).toHaveCount(6); // excluded row has no visible check
  // Approving a row renames its button to "Mark unverified", so always click
  // the first remaining "Approve row".
  for (let i = 0; i < 6; i++) {
    if (i < 5) await expect(page.getByTestId("generate-pdf")).toBeDisabled();
    await approveButtons.first().click();
    await expect(page.getByTestId("verify-progress")).toContainText(`${i + 1} / 6 verified`);
  }
  await expect(page.getByTestId("verify-progress")).toContainText("6 / 6 verified");
  await expect(page.getByTestId("generate-pdf")).toBeEnabled();

  // Editing a verified row revokes its approval (human must re-check).
  const paperRow = rowByDesc("KS PAPER TOWEL");
  await paperRow.getByLabel("Amount").fill("27.99");
  await paperRow.getByLabel("Amount").blur();
  await expect(page.getByTestId("verify-progress")).toContainText("5 / 6 verified");
  await expect(page.getByTestId("generate-pdf")).toBeDisabled();
  await paperRow.getByRole("button", { name: "Approve row" }).click();
  await expect(page.getByTestId("generate-pdf")).toBeEnabled();
  await shot(page, "06-review-verified");

  // --- Phase 4: PDF generation ---
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("generate-pdf").click(),
  ]);
  const pdfPath = `${SHOTS}/claim-packet.pdf`;
  await download.saveAs(pdfPath);
  const bytes = await fs.readFile(pdfPath);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  const doc = await PDFDocument.load(new Uint8Array(bytes));
  // 6 line items -> 1 form page, plus the 2 receipt images.
  expect(doc.getPageCount()).toBe(3);

  await expect(page.getByTestId("claim-status")).toHaveText("Generated", { timeout: 15_000 });
  await shot(page, "07-claim-generated");

  // --- Prompt-tuning telemetry: AI calls + human corrections were recorded ---
  const claimId = page.url().match(/claims\/([^/]+)/)![1];
  const logsRes = await page.request.get(`/api/extraction-logs?reimbursementId=${claimId}`);
  expect(logsRes.ok()).toBeTruthy();
  const { logs } = await logsRes.json();
  // One extraction call per receipt.
  expect(logs).toHaveLength(2);
  expect(logs.every((l: { status: string }) => l.status === "success")).toBe(true);

  const details = await Promise.all(
    logs.map(async (l: { id: string }) =>
      (await page.request.get(`/api/extraction-logs/${l.id}`)).json()
    )
  );
  // The exact request/response pair is preserved per call; the two receipts
  // (4-item purchase + 2-item refund) each got their own log.
  for (const d of details) {
    expect(d.log.prompt).toContain("one receipt document");
    expect(d.log.rawResponse).toBeTruthy();
  }
  const itemCounts = details.map((d) => JSON.parse(d.log.parsedJson).length).sort();
  expect(itemCounts).toEqual([2, 4]);
  const detail = details.find((d) => JSON.parse(d.log.parsedJson).length === 4)!;
  // Human corrections are derivable per line item (original AI value vs final).
  const taxItem = detail.lineItems.find(
    (it: { description: string; corrections: Record<string, unknown> }) =>
      it.description === "Sales Tax"
  );
  expect(taxItem.corrections.amountCents).toEqual({ from: 864, to: 725 });
  const splitHalf = detail.lineItems.filter(
    (it: { description: string }) => it.description === "FOLDING TABLE 6FT"
  );
  expect(splitHalf.some((it: { humanCreated: boolean }) => it.humanCreated)).toBe(true);
  // And the chronological audit trail includes the split and the exclusion.
  const actions = detail.auditEvents.map((e: { action: string }) => e.action);
  expect(actions).toContain("split");
  const exclusion = detail.auditEvents.find(
    (e: { detail: { changes?: { isExcluded?: { to: boolean } } } }) =>
      e.detail.changes?.isExcluded?.to === true
  );
  expect(exclusion).toBeTruthy();

  // --- Phase 5 prep: receipts are consumed, claim is frozen ---
  await page.goto("/shoebox");
  await expect(page.getByText("Processed receipts (2)")).toBeVisible();
  await page.goto("/claims");
  await expect(page.getByText("Generated", { exact: true })).toBeVisible();
  await shot(page, "08-claims-list");
});

test("claim with more items than the 13-row form paginates onto two form pages", async ({ page }, testInfo) => {
  await signInAs(page, `manyitems-${testInfo.project.name}@example.com`);
  await page.goto("/shoebox");
  const fixtures = [];
  for (let i = 0; i < 4; i++) fixtures.push(await makeReceiptFixture(`bulk-${i}.jpg`));
  await uploadReceipts(page, fixtures);
  for (const card of await page.locator('[data-testid^="receipt-card-"]').all()) await card.click();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });

  // 4 receipts x 4 mock items = 16 rows.
  const rows = page.locator('li[data-testid^="row-"]');
  await expect(rows).toHaveCount(16);
  const approve = page.getByRole("button", { name: "Approve row" });
  for (let i = 0; i < 16; i++) {
    await approve.first().click();
    await expect(page.getByTestId("verify-progress")).toContainText(`${i + 1} / 16 verified`);
  }
  await expect(page.getByTestId("generate-pdf")).toBeEnabled();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("generate-pdf").click(),
  ]);
  const bytes = await fs.readFile((await download.path())!);
  const doc = await PDFDocument.load(new Uint8Array(bytes));
  // 16 items -> 2 form pages + 4 receipt pages.
  expect(doc.getPageCount()).toBe(6);
});
