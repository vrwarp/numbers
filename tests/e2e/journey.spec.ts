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

// Mock extraction fixtures (deterministic; see src/lib/ai/mock.ts):
//   costco.jpg        → Costco Wholesale, net $102.10
//   amazon-refund.jpg → Amazon, charged $36.31 − refunded $5.36 = net $30.95
//   costco-return.jpg → pure return, net −$27.98
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
  const refund = await makeReceiptFixture("amazon-refund.jpg");
  const pureReturn = await makeReceiptFixture("costco-return.jpg", { refund: true });
  await uploadReceipts(page, [purchase, refund, pureReturn]);
  await shot(page, "04-shoebox-uploaded");

  // Compression: stored files should be small (~100 KB budget).
  const receiptsJson = await (await page.request.get("/api/receipts")).json();
  expect(receiptsJson.receipts).toHaveLength(3);
  for (const r of receiptsJson.receipts) {
    expect(r.sizeBytes).toBeLessThan(120 * 1024);
    expect(r.mimeType).toBe("image/jpeg");
  }

  // --- Phase 2: batch & generate ---
  for (const card of await page.locator('[data-testid^="receipt-card-"]').all()) {
    await card.click();
  }
  await expect(page.getByText("3 receipts selected")).toBeVisible();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });

  // --- Phase 3: review & validate ---
  await expect(page.getByTestId("claim-status")).toHaveText("Draft");
  const rows = page.locator('li[data-testid^="row-"]');
  await expect(rows).toHaveCount(3); // ONE row per receipt
  await expect(page.getByText("REFUND", { exact: true })).toHaveCount(1); // the pure return
  await shot(page, "05-review-initial");

  // Merchant + date extracted onto the receipt group headers.
  await expect(page.getByText("Costco Wholesale — 06/21/2026")).toHaveCount(2); // receipt pane + group
  await expect(page.getByText("Amazon — 06/04/2026")).toHaveCount(2);

  // Row amounts are net totals; the refund receipt shows its derivation.
  await expect(page.getByText("Subtotal: $102.10")).toBeVisible();
  await expect(page.getByText("Subtotal: $30.95")).toBeVisible();
  await expect(page.getByText("Subtotal: -$27.98")).toBeVisible();
  await expect(page.getByText("Charged $36.31 − refunded $5.36 → suggested $30.95")).toBeVisible();
  await expect(page.getByTestId("claim-total")).toHaveText("$105.07");

  // The PDF button stays locked until every row is verified.
  await expect(page.getByTestId("generate-pdf")).toBeDisabled();

  // Descriptions render as textarea values, so match rows by data attribute.
  const rowByDesc = (descPart: string) =>
    page.locator(`li[data-testid^="row-"][data-description*="${descPart}"]`);

  // The return was already reimbursed offline — exclude the whole receipt row.
  const returnRow = rowByDesc("KS paper towel (refunded)");
  await returnRow.getByTitle("Exclude item (personal / not reimbursable)").click();
  await expect(page.getByTestId("claim-total")).toHaveText("$133.05");

  // Part of the Costco run was personal: edit the amount down and note it.
  const costcoRow = rowByDesc("Costco Wholesale 06/21");
  await costcoRow.getByLabel("Amount").fill("90.00");
  await costcoRow.getByLabel("Amount").blur();
  await expect(page.getByTestId("claim-total")).toHaveText("$120.95");

  // Split the Amazon order between two ministries.
  const amazonRow = rowByDesc("Amazon 06/04").first();
  await amazonRow.getByTitle("Split into two rows").click();
  await page.getByTestId("split-first-amount").fill("15.00");
  await page.getByTestId("split-confirm").click();
  await expect(rows).toHaveCount(4);
  const amazonRows = rowByDesc("Amazon 06/04");
  await expect(amazonRows).toHaveCount(2);
  await expect(page.getByTestId("claim-total")).toHaveText("$120.95"); // split conserves the total
  // Assign the second half to a different ministry.
  await amazonRows.nth(1).getByLabel("Ministry").selectOption("Footprints");

  // Verify every active row; the button unlocks only at 3/3.
  await expect(page.getByTestId("verify-progress")).toContainText("0 / 3 verified");
  const approveButtons = page.getByRole("button", { name: "Approve row" });
  await expect(approveButtons).toHaveCount(3); // excluded row has no visible check

  // Rows arrive with no ministry — the AI never suggests one, and approving
  // is blocked until the user explicitly picks.
  await expect(approveButtons.first()).toBeDisabled();
  for (const sel of await page.getByLabel("Ministry").all()) {
    if (await sel.isDisabled()) continue; // excluded row
    if (!(await sel.inputValue())) await sel.selectOption("General Fund");
  }
  // Approving a row renames its button to "Mark unverified", so always click
  // the first remaining "Approve row".
  for (let i = 0; i < 3; i++) {
    if (i < 2) await expect(page.getByTestId("generate-pdf")).toBeDisabled();
    await approveButtons.first().click();
    await expect(page.getByTestId("verify-progress")).toContainText(`${i + 1} / 3 verified`);
  }
  await expect(page.getByTestId("verify-progress")).toContainText("3 / 3 verified");
  await expect(page.getByTestId("generate-pdf")).toBeEnabled();

  // Editing a verified row revokes its approval (human must re-check).
  await costcoRow.getByLabel("Amount").fill("90.01");
  await costcoRow.getByLabel("Amount").blur();
  await expect(page.getByTestId("verify-progress")).toContainText("2 / 3 verified");
  await expect(page.getByTestId("generate-pdf")).toBeDisabled();
  await costcoRow.getByLabel("Amount").fill("90.00");
  await costcoRow.getByLabel("Amount").blur();
  await costcoRow.getByRole("button", { name: "Approve row" }).click();
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
  // 3 active rows -> 1 form page + 2 receipt images; the fully-excluded
  // return receipt is left out of the packet.
  expect(doc.getPageCount()).toBe(3);

  await expect(page.getByTestId("claim-status")).toHaveText("Generated", { timeout: 15_000 });
  await shot(page, "07-claim-generated");

  // --- Prompt-tuning telemetry: AI calls + human corrections were recorded ---
  const claimId = page.url().match(/claims\/([^/]+)/)![1];
  const logsRes = await page.request.get(`/api/extraction-logs?reimbursementId=${claimId}`);
  expect(logsRes.ok()).toBeTruthy();
  const { logs } = await logsRes.json();
  // One extraction call per receipt.
  expect(logs).toHaveLength(3);
  expect(logs.every((l: { status: string }) => l.status === "success")).toBe(true);

  const details = await Promise.all(
    logs.map(async (l: { id: string }) =>
      (await page.request.get(`/api/extraction-logs/${l.id}`)).json()
    )
  );
  // The exact request/response pair is preserved per call, one receipt-level
  // result each.
  for (const d of details) {
    expect(d.log.prompt).toContain("one receipt document");
    expect(d.log.rawResponse).toBeTruthy();
  }
  const merchants = details.map((d) => JSON.parse(d.log.parsedJson).merchant).sort();
  expect(merchants).toEqual(["Amazon", "Costco Wholesale", "Costco Wholesale"]);
  const detail = details.find((d) => JSON.parse(d.log.parsedJson).totalAmount === 102.1)!;
  // Human corrections are derivable per line item (original AI value vs final).
  const costcoItem = detail.lineItems.find(
    (it: { description: string; corrections: Record<string, unknown> }) =>
      it.description.startsWith("Costco Wholesale 06/21")
  );
  expect(costcoItem.corrections.amountCents).toEqual({ from: 10210, to: 9000 });
  const amazonHalves = detail.lineItems.filter((it: { description: string }) =>
    it.description.startsWith("Amazon 06/04")
  );
  expect(amazonHalves.some((it: { humanCreated: boolean }) => it.humanCreated)).toBe(true);
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
  await expect(page.getByText("Processed receipts (3)")).toBeVisible();
  await page.goto("/claims");
  await expect(page.getByText("Generated", { exact: true })).toBeVisible();
  await shot(page, "08-claims-list");
});

test("claim with more receipts than the 13-row form paginates onto two form pages", async ({ page }, testInfo) => {
  await signInAs(page, `manyitems-${testInfo.project.name}@example.com`);
  await page.goto("/shoebox");
  const fixtures = [];
  for (let i = 0; i < 14; i++) fixtures.push(await makeReceiptFixture(`bulk-${i}.jpg`));
  await uploadReceipts(page, fixtures);
  for (const card of await page.locator('[data-testid^="receipt-card-"]').all()) await card.click();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });

  // 14 receipts x 1 row each = 14 rows.
  const rows = page.locator('li[data-testid^="row-"]');
  await expect(rows).toHaveCount(14);
  for (const sel of await page.getByLabel("Ministry").all()) {
    await sel.selectOption("General Fund");
  }
  const approve = page.getByRole("button", { name: "Approve row" });
  for (let i = 0; i < 14; i++) {
    await approve.first().click();
    await expect(page.getByTestId("verify-progress")).toContainText(`${i + 1} / 14 verified`);
  }
  await expect(page.getByTestId("generate-pdf")).toBeEnabled();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("generate-pdf").click(),
  ]);
  const bytes = await fs.readFile((await download.path())!);
  const doc = await PDFDocument.load(new Uint8Array(bytes));
  // 14 rows -> 2 form pages + 14 receipt pages.
  expect(doc.getPageCount()).toBe(16);
});
