import { test, expect } from "@playwright/test";
import fs from "fs/promises";
import path from "path";
import { makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

/**
 * The background annotation pipeline. The e2e server keeps the worker DORMANT
 * (EXTRACTION_PACE_MS=900000 in start-server.sh) so every other spec runs on
 * deterministic claim-time extraction; this spec wakes it by flipping the pace
 * to 0 through the DATA_DIR config.json hot-reload (the documented runtime
 * override), and restores the file afterwards. While awake the worker reads
 * the upload, the Shoebox tile surfaces what was read, and claim creation
 * consumes the stored annotation WITHOUT a fresh AI call — the upload-time
 * extraction log is adopted by the claim that used it.
 */

const CONFIG_FILE = path.join(process.cwd(), ".e2e-data", "config.json");

async function setExtractionPace(paceMs: number | null): Promise<void> {
  await fs.writeFile(
    CONFIG_FILE,
    JSON.stringify(paceMs === null ? {} : { EXTRACTION_PACE_MS: String(paceMs) }) + "\n",
    "utf8"
  );
}

// Restore the env-configured dormancy even if the test fails mid-way.
test.afterEach(async () => {
  await setExtractionPace(null).catch(() => {});
});

test("receipts are read in the background and claims reuse the stored annotation", async ({
  page,
}, testInfo) => {
  await signInAs(
    page,
    `bganno-${testInfo.project.name}-r${testInfo.retry}@example.com`,
    "Backy Ground"
  );

  // Wake the drip: the worker re-reads the pace every poll (≤250ms in e2e).
  await setExtractionPace(0);

  await page.goto("/shoebox");
  await uploadReceipts(page, [await makeReceiptFixture("costco.jpg")]);
  const receipts = (await (await page.request.get("/api/receipts")).json()).receipts as {
    id: string;
    annotation: string;
  }[];
  const costco = receipts[0];

  // The worker annotates it shortly after upload; the API flips to "ready".
  await expect
    .poll(
      async () =>
        ((await (await page.request.get("/api/receipts")).json()).receipts as {
          id: string;
          annotation: string;
        }[]).find((r) => r.id === costco.id)?.annotation,
      { timeout: 30_000 }
    )
    .toBe("ready");

  // The upload-time read left exactly one telemetry log, not yet claim-linked.
  const preLogs = ((await (await page.request.get("/api/extraction-logs")).json()).logs as {
    kind: string;
    reimbursementId: string | null;
  }[]).filter((l) => l.kind === "receipt");
  expect(preLogs).toHaveLength(1);
  expect(preLogs[0].reimbursementId).toBeNull();

  // The tile chip shows what was read (merchant · net amount).
  await page.reload();
  const chip = page.getByTestId(`receipt-annotation-${costco.id}`);
  await expect(chip).toHaveAttribute("data-state", "ready");
  await expect(chip).toContainText("Costco Wholesale");
  await expect(chip).toContainText("$102.10");

  // Claim creation consumes the annotation: same row a live extraction would
  // have produced, and it completes without waiting on the provider.
  await page.getByTestId(`receipt-card-${costco.id}`).click();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });
  const claimId = page.url().match(/claims\/([^/]+)/)![1];
  await expect(page.locator('[data-description*="Costco Wholesale 06/21"]')).toBeVisible();
  await expect(page.getByTestId("claim-total")).toHaveText("$102.10");

  // No second AI call was made — the claim ADOPTED the upload-time log.
  const claimLogs = (
    await (await page.request.get(`/api/extraction-logs?reimbursementId=${claimId}`)).json()
  ).logs as { id: string; status: string }[];
  expect(claimLogs).toHaveLength(1);
  expect(claimLogs[0].status).toBe("success");
  const allLogs = ((await (await page.request.get("/api/extraction-logs")).json()).logs as {
    kind: string;
  }[]).filter((l) => l.kind === "receipt");
  expect(allLogs).toHaveLength(1);
  // The adopted log powers the same prompt-tuning detail view as an inline one.
  const detail = await (
    await page.request.get(`/api/extraction-logs/${claimLogs[0].id}`)
  ).json();
  expect(JSON.parse(detail.log.parsedJson).merchant).toBe("Costco Wholesale");
  expect(detail.lineItems).toHaveLength(1);
  expect(detail.lineItems[0].humanCreated).toBe(false);

  // A SECOND claim from the same receipt reuses the annotation too (still no
  // new AI call); the one log stays with the claim that adopted it first.
  const res2 = await page.request.post("/api/reimbursements", {
    data: { receiptIds: [costco.id] },
  });
  expect(res2.status()).toBe(201);
  const claim2 = (await res2.json()).reimbursement as {
    id: string;
    totalCents: number;
    lineItems: { description: string; amountCents: number; originalAmountCents: number }[];
  };
  expect(claim2.lineItems).toHaveLength(1);
  expect(claim2.lineItems[0].description).toContain("Costco Wholesale 06/21");
  expect(claim2.lineItems[0].amountCents).toBe(10210);
  expect(claim2.lineItems[0].originalAmountCents).toBe(10210);
  const claim2Logs = (
    await (await page.request.get(`/api/extraction-logs?reimbursementId=${claim2.id}`)).json()
  ).logs as unknown[];
  expect(claim2Logs).toHaveLength(0);
  const allLogs2 = ((await (await page.request.get("/api/extraction-logs")).json()).logs as {
    kind: string;
  }[]).filter((l) => l.kind === "receipt");
  expect(allLogs2).toHaveLength(1);
});
