import { test, expect } from "@playwright/test";
import fs from "fs/promises";
import { completeProfile, makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

/**
 * Single-ministry mode + the "Suggest" flow. New claims default to one
 * ministry for every row: the claim-level selector replaces the per-row
 * ones, a one-sentence description can ask the (mock) AI for a suggestion,
 * and switching modes adopts/restores row values with an undo.
 *
 * Mock fixtures: every plain-named receipt extracts as Costco net $102.10
 * (see src/lib/ai/mock.ts); mock suggestions key on description keywords
 * ("youth"+"retreat" → 471 Youth Retreat — see src/lib/ai/suggest.ts).
 */

async function makeClaim(page: import("@playwright/test").Page, names: string[]) {
  await page.goto("/");
  const fixtures = [];
  for (const n of names) fixtures.push(await makeReceiptFixture(n));
  await uploadReceipts(page, fixtures);
  for (const card of await page.locator('[data-testid^="receipt-card-"]').all()) await card.click();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });
  return page.url().split("/").pop()!;
}


test("describe → Suggest → apply fans the ministry onto every row and unlocks the PDF", async ({
  page,
}, testInfo) => {
  await signInAs(
    page,
    `suggest-${testInfo.project.name}-r${testInfo.retry}@example.com`,
    "Sue Jest"
  );
  await completeProfile(page);
  const claimId = await makeClaim(page, ["sm-a.jpg", "sm-b.jpg", "sm-c.jpg"]);

  // Default is single-ministry mode: the claim panel is up, the per-row
  // selectors are gone, and every row wears the "set above" badge.
  await expect(page.getByTestId("claim-ministry-panel")).toBeVisible();
  await expect(page.getByLabel("Ministry", { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-testid^="row-ministry-badge-"]')).toHaveCount(3);
  const approveButtons = page.getByRole("button", { name: "Looks correct", pressed: false });
  await expect(approveButtons.first()).toBeDisabled(); // no ministry yet

  // One sentence in, one suggestion out — pending until the human applies it.
  await page.getByTestId("claim-description").fill("Snacks for the youth retreat");
  await page.getByTestId("suggest-ministry").click();
  await expect(page.getByTestId("suggestion-banner")).toContainText(
    "471 Youth Retreat — Youth Retreat"
  );
  await fs.mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/11-single-ministry-suggest.png", fullPage: true });
  // Nothing applied yet: rows still have no ministry.
  await expect(approveButtons.first()).toBeDisabled();

  // Apply the suggestion
  await page.getByTestId("suggestion-apply").click();
  await expect(page.getByTestId("suggestion-undo")).toBeVisible();
  await expect(page.getByTestId("fanout-toast")).toBeHidden();

  // Test the undo action
  await page.getByTestId("suggestion-undo").click();
  await expect(page.getByTestId("suggestion-apply")).toBeVisible();
  await expect(page.locator('[data-testid^="row-ministry-badge-"]').filter({ hasText: "471" })).toHaveCount(0);

  // Re-apply it
  await page.getByTestId("suggestion-apply").click();
  await expect(
    page
      .locator('[data-testid^="row-ministry-badge-"]')
      .filter({ hasText: "471 Youth Retreat — Youth Retreat" })
  ).toHaveCount(3);
  await expect(page.getByTestId("claim-ministry")).toHaveValue("471 Youth Retreat");

  // Rows are stamped but NOT verified — the human still confirms each amount.
  await expect(page.getByTestId("verify-progress")).toContainText("0 / 3 verified");
  for (let i = 0; i < 3; i++) {
    await approveButtons.first().click();
    await expect(page.getByTestId("verify-progress")).toContainText(`${i + 1} / 3 verified`);
  }
  // The verify clicks are optimistic + queued client-side, so "3 / 3 verified"
  // can show before the last PATCH commits. The real Download button drains
  // that queue (ReviewClaim.generatePdf); this raw POST bypasses it, so wait
  // for the server to actually reflect all three before hitting the gate.
  await expect
    .poll(async () =>
      (
        (await (await page.request.get(`/api/reimbursements/${claimId}`)).json())
          .reimbursement.lineItems as { isVerified: boolean }[]
      ).filter((li) => li.isVerified).length
    )
    .toBe(3);
  expect((await page.request.post(`/api/reimbursements/${claimId}/pdf`)).status()).toBe(200);

  // Telemetry: the suggestion call was logged alongside the extractions.
  const { logs } = await (
    await page.request.get(`/api/extraction-logs?reimbursementId=${claimId}`)
  ).json();
  const kinds = logs.map((l: { kind: string }) => l.kind);
  expect(kinds.filter((k: string) => k === "suggestion")).toHaveLength(1);
  expect(kinds.filter((k: string) => k === "receipt")).toHaveLength(3);

  // The description was persisted as the claim note.
  const { reimbursement } = await (
    await page.request.get(`/api/reimbursements/${claimId}`)
  ).json();
  expect(reimbursement.claimDescription).toBe("Snacks for the youth retreat");
});

test("switching multi → single adopts the most common ministry, un-verifies, and undoes", async ({
  page,
}, testInfo) => {
  await signInAs(
    page,
    `modes-${testInfo.project.name}-r${testInfo.retry}@example.com`,
    "Moe Diswitch"
  );
  await makeClaim(page, ["mm-a.jpg", "mm-b.jpg", "mm-c.jpg"]);

  // Multi mode brings the per-row selectors back.
  await page.getByTestId("claim-mode-multi").click();
  const selects = page.getByLabel("Ministry", { exact: true });
  await expect(selects).toHaveCount(3);
  await selects.nth(0).selectOption("320 VBS");
  await selects.nth(1).selectOption("320 VBS");
  await selects.nth(2).selectOption("237 Office Supplies");
  // Verify the odd one out, so the switch has something to un-verify.
  const approveButtons = page.getByRole("button", { name: "Looks correct", pressed: false });
  await approveButtons.nth(2).click();
  await expect(page.getByTestId("verify-progress")).toContainText("1 / 3 verified");

  // Rows diverge → the switch asks first, spelling out the adoption.
  await page.getByTestId("claim-mode-single").click();
  await expect(page.getByTestId("mode-switch-dialog")).toContainText("320 VBS");
  await expect(page.getByTestId("mode-switch-dialog")).toContainText(
    "1 verified row will need re-verifying"
  );
  await page.getByTestId("mode-switch-cancel").click();
  await expect(selects).toHaveCount(3); // still multi

  await page.getByTestId("claim-mode-single").click();
  await page.getByTestId("mode-switch-confirm").click();
  await expect(
    page.locator('[data-testid^="row-ministry-badge-"]').filter({ hasText: "320 VBS" })
  ).toHaveCount(3);
  await expect(page.getByTestId("verify-progress")).toContainText("0 / 3 verified");

  // One click takes the whole fan-out back: mode, row ministry, verification.
  await expect(page.getByTestId("fanout-toast")).toBeVisible();
  await page.getByTestId("fanout-undo").click();
  await expect(selects).toHaveCount(3);
  await expect(selects.nth(2)).toHaveValue("237 Office Supplies");
  await expect(page.getByTestId("verify-progress")).toContainText("1 / 3 verified");
});

test("Reassigning a split-off portion in single mode switches the claim to multiple", async ({
  page,
}, testInfo) => {
  await signInAs(
    page,
    `splitgate-${testInfo.project.name}-r${testInfo.retry}@example.com`,
    "Splid Gate"
  );
  await makeClaim(page, ["sg-a.jpg", "sg-b.jpg"]);

  await page.getByTestId("claim-ministry").selectOption("250 Luncheon Catering");
  await expect(
    page.locator('[data-testid^="row-ministry-badge-"]').filter({ hasText: "250 Luncheon Catering" })
  ).toHaveCount(2);
  // Clear the undo toast so it can't sit over the row buttons below.
  await page.getByTestId("fanout-toast").getByLabel("Dismiss").click();

  // The inline editor opens in the row (no modal); reassigning the portion to a
  // *different* ministry warns that the claim will become multi-ministry.
  await page.getByTitle("Split into two rows").first().click();
  await page.getByTestId("split-amount").fill("50.00");
  await expect(page.getByTestId("split-mode-note")).toBeHidden();
  await page.getByTestId("split-ministry").selectOption("440 Youth Fellowship (aka Footprint)");
  await expect(page.getByTestId("split-mode-note")).toBeVisible();
  await page.getByTestId("split-confirm").click(); // labelled "Switch & split"

  // The claim is now multi-ministry: per-row selects, three rows.
  await expect(page.locator('li[data-testid^="row-"]')).toHaveCount(3);
  const selects = page.getByLabel("Ministry", { exact: true });
  await expect(selects).toHaveCount(3);
  // The original keeps its ministry; the split-off portion carries the new one.
  await expect(selects.nth(0)).toHaveValue("250 Luncheon Catering");
  await expect(selects.nth(1)).toHaveValue("440 Youth Fellowship (aka Footprint)");
});

test("A personal split in single mode stays single-ministry (no needless switch)", async ({
  page,
}, testInfo) => {
  await signInAs(
    page,
    `splitpers-${testInfo.project.name}-r${testInfo.retry}@example.com`,
    "Splid Person"
  );
  await makeClaim(page, ["sg-a.jpg", "sg-b.jpg"]);

  await page.getByTestId("claim-ministry").selectOption("250 Luncheon Catering");
  await expect(
    page.locator('[data-testid^="row-ministry-badge-"]').filter({ hasText: "250 Luncheon Catering" })
  ).toHaveCount(2);
  await page.getByTestId("fanout-toast").getByLabel("Dismiss").click();

  // Carve off a personal portion — nothing about the claim's ministry changes,
  // so it must NOT prompt a mode switch and stays single-ministry.
  await page.getByTitle("Split into two rows").first().click();
  await page.getByTestId("split-amount").fill("40.00");
  await page.getByTestId("split-mode-personal").click();
  await expect(page.getByTestId("split-mode-note")).toBeHidden();
  await page.getByTestId("split-confirm").click(); // labelled "Split & don't claim"

  // Still single-ministry: rows keep read-only badges (not per-row selects), and
  // the carved-off portion is marked "not claimed".
  await expect(page.getByLabel("Ministry", { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-testid^="row-ministry-badge-"]')).toHaveCount(2);
  await expect(page.locator('[data-testid^="row-notclaimed-"]')).toHaveCount(1);
});

test("claim settings and suggestions are tenant-scoped (404, never 403)", async ({
  browser,
}, testInfo) => {
  const owner = await (await browser.newContext()).newPage();
  await signInAs(
    owner,
    `tenant-a-${testInfo.project.name}-r${testInfo.retry}@example.com`,
    "Tena Aye"
  );
  const claimId = await makeClaim(owner, ["ta-a.jpg"]);

  const other = await (await browser.newContext()).newPage();
  await signInAs(
    other,
    `tenant-b-${testInfo.project.name}-r${testInfo.retry}@example.com`,
    "Tenn Bee"
  );
  const patched = await other.request.patch(`/api/reimbursements/${claimId}`, {
    data: { singleMinistry: false },
  });
  expect(patched.status()).toBe(404);
  const suggested = await other.request.post(`/api/reimbursements/${claimId}/suggest`, {
    data: { description: "office supplies" },
  });
  expect(suggested.status()).toBe(404);
});

test("the Category Guide fills the per-row selector (and the claim-level one)", async ({
  page,
}, testInfo) => {
  await signInAs(
    page,
    `guide-${testInfo.project.name}-r${testInfo.retry}@example.com`,
    "Guy Dee"
  );
  await makeClaim(page, ["gd-a.jpg", "gd-b.jpg"]);

  // Claim-level selector: the magnifying-glass button opens the guide; a
  // number search narrows to one category and picking it fans out to the rows.
  await page.getByTestId("browse-categories").first().click();
  await expect(page.getByTestId("category-guide")).toBeVisible();
  await page.getByTestId("guide-search").fill("245");
  await expect(page.getByTestId("guide-item")).toHaveCount(1);
  await page.getByTestId("guide-item").click();
  await expect(page.getByTestId("category-guide")).toBeHidden();
  await expect(page.getByTestId("claim-ministry")).toHaveValue("245 Drinking Water");
  await expect(
    page.locator('[data-testid^="row-ministry-badge-"]').filter({ hasText: "245 Drinking Water" })
  ).toHaveCount(2);
  await page.getByTestId("fanout-toast").getByLabel("Dismiss").click();

  // Per-row selector (multiple-ministries mode): every row gets its own
  // guide button, and a name search fills just that row's select.
  await page.getByTestId("claim-mode-multi").click();
  const rowSelects = page.locator('select[data-testid^="ministry-"]');
  await expect(rowSelects).toHaveCount(2);
  const rowGuideButtons = page.locator('[data-testid="browse-categories"]');
  await expect(rowGuideButtons).toHaveCount(2); // one per row, none at claim level now
  await rowGuideButtons.first().click();
  await page.getByTestId("guide-search").fill("luncheon");
  await page.getByTestId("guide-item").first().click();
  await expect(rowSelects.first()).toHaveValue("250 Luncheon Catering");
  // The other row keeps the value the earlier fan-out gave it — the guide
  // pick touched only its own row.
  await expect(rowSelects.nth(1)).toHaveValue("245 Drinking Water");
});
