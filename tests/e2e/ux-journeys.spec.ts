import { test, expect, Page, TestInfo } from "@playwright/test";
import { makeReceiptFixture, shoeboxReady, signInAs, uploadReceipts, completeProfile } from "./helpers";

/**
 * Journeys over recently shipped UX fixes: the profile→PDF gate round-trip,
 * bulk verify, row-based progress for a split single receipt, silent-revert
 * feedback on bad row edits, Shoebox selection a11y + camera affordances,
 * named delete confirms, Escape-closes-dialogs baseline, pending-photo
 * crash restore, and the sign-in ?return= path.
 *
 * Runs on the desktop projects only (the config's mobile/short projects
 * testMatch other specs). Mock extraction (AI_MOCK=1) is deterministic:
 * a plain fixture reads as Costco Wholesale, net $102.10.
 */

const email = (kase: string, testInfo: TestInfo) =>
  `uxj-${kase}-${testInfo.project.name}-r${testInfo.retry}@example.com`;

/** Select every visible receipt card and generate a claim; returns the claim id. */
async function createClaimFromAllReceipts(page: Page): Promise<string> {
  for (const card of await page.locator('[data-testid^="receipt-card-"]').all()) {
    await card.click();
  }
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });
  return page.url().match(/claims\/([^/]+)/)![1];
}

async function fetchLineItems(page: Page, claimId: string) {
  const res = await page.request.get(`/api/reimbursements/${claimId}`);
  expect(res.ok()).toBeTruthy();
  const { reimbursement } = await res.json();
  return reimbursement.lineItems as {
    id: string;
    description: string;
    amountCents: number;
  }[];
}

test("profile→PDF gate: banner links to profile and returns to unlock the claim", async ({ page }, testInfo) => {
  // Deliberately NO completeProfile — the gate under test.
  await signInAs(page, email("gate", testInfo));
  await uploadReceipts(page, [await makeReceiptFixture("uxj-gate.jpg")]);
  const claimId = await createClaimFromAllReceipts(page);

  // A single-receipt claim renders the per-row ministry select even in
  // single-ministry mode, but the API is the sturdier path: set the ministry
  // and verify the one row so the profile is the only thing blocking the PDF.
  const [item] = await fetchLineItems(page, claimId);
  const patched = await page.request.patch(`/api/line-items/${item.id}`, {
    data: { ministry: "237 Office Supplies", isVerified: true },
  });
  expect(patched.ok()).toBeTruthy();
  await page.reload();

  await expect(page.getByTestId("profile-incomplete-banner")).toBeVisible();
  await expect(page.getByTestId("generate-pdf")).toBeDisabled();

  // The disabled button is cosmetic — the server enforces the gate.
  const pdfRes = await page.request.post(`/api/reimbursements/${claimId}/pdf`);
  expect(pdfRes.status()).toBe(400);
  expect((await pdfRes.json()).code).toBe("profileIncomplete");

  // Banner link carries the way back to this claim.
  await page.getByTestId("profile-incomplete-link").click();
  await page.waitForURL(
    (u) => u.pathname === "/profile" && u.searchParams.get("return") === `/claims/${claimId}`
  );
  await expect(page.getByTestId("profile-name")).toBeVisible();
  await page.getByTestId("profile-name").fill("Gate Tester");
  await page.getByTestId("profile-address").fill("1 Test Way, San Jose, CA 95110");
  await page.getByTestId("profile-save").click();

  // Saving a now-complete profile closes the loop back to the claim.
  await page.waitForURL(new RegExp(`/claims/${claimId}$`));
  await expect(page.getByTestId("profile-incomplete-banner")).toHaveCount(0);
  await expect(page.getByTestId("generate-pdf")).toBeEnabled();
});

test("verify-all confirms once and verifies every ministry-assigned row", async ({ page }, testInfo) => {
  await signInAs(page, email("verifyall", testInfo));
  await completeProfile(page);
  await page.goto("/");
  await uploadReceipts(page, [
    await makeReceiptFixture("uxj-va-1.jpg"),
    await makeReceiptFixture("uxj-va-2.jpg"),
    await makeReceiptFixture("uxj-va-3.jpg"),
  ]);
  const claimId = await createClaimFromAllReceipts(page);

  // Give every row a ministry but leave it unverified (a fan-out would
  // un-verify anyway; the API keeps it minimal).
  for (const item of await fetchLineItems(page, claimId)) {
    const res = await page.request.patch(`/api/line-items/${item.id}`, {
      data: { ministry: "General Fund" },
    });
    expect(res.ok()).toBeTruthy();
  }
  await page.reload();

  const progress = page.getByTestId("verify-progress");
  await expect(progress).toContainText("0 / 3 verified");
  const verifyAll = progress.getByTestId("verify-all");
  await expect(verifyAll).toBeVisible();
  await verifyAll.click();

  // The bulk attestation stays deliberate: a confirm dialog first.
  await expect(page.getByTestId("claim-confirm")).toBeVisible();
  await page.getByTestId("claim-confirm-confirm").click();

  await expect(progress).toContainText("3 / 3 verified");
  await expect(page.getByTestId("generate-pdf")).toBeEnabled();
});

test("splitting a single-receipt claim reveals row-based verify progress", async ({ page }, testInfo) => {
  await signInAs(page, email("splitprog", testInfo));
  await uploadReceipts(page, [await makeReceiptFixture("uxj-split.jpg")]);
  const claimId = await createClaimFromAllReceipts(page);

  // One active row → no progress bar yet.
  await expect(page.getByTestId("verify-progress")).toHaveCount(0);

  const [item] = await fetchLineItems(page, claimId);
  const res = await page.request.post(`/api/line-items/${item.id}/split`, { data: {} });
  expect(res.ok()).toBeTruthy();
  await page.reload();

  // Progress tracks ROWS, not receipts — a split single receipt now shows it.
  await expect(page.getByTestId("verify-progress")).toBeVisible();
  await expect(page.getByTestId("verify-progress")).toContainText("0 / 2");
});

test("unreadable row edits restore the old value and say so", async ({ page }, testInfo) => {
  await signInAs(page, email("revert", testInfo));
  await uploadReceipts(page, [await makeReceiptFixture("uxj-revert.jpg")]);
  const claimId = await createClaimFromAllReceipts(page);
  const [item] = await fetchLineItems(page, claimId);

  // Garbage amount → field restored + explicit feedback (not a silent reset).
  const amount = page.getByTestId(`amount-${item.id}`);
  await expect(amount).toHaveValue("102.10");
  await amount.fill("12..34");
  await amount.blur();
  await expect(amount).toHaveValue("102.10");
  await expect(
    page.getByText(/^Couldn['’]t read that amount — restored the previous value\.$/)
  ).toBeVisible();

  // Emptied description → restored + its own message.
  const desc = page.getByTestId(`desc-${item.id}`);
  const original = await desc.inputValue();
  expect(original.length).toBeGreaterThan(0);
  await desc.fill("");
  await desc.blur();
  await expect(desc).toHaveValue(original);
  await expect(
    page.getByText("A description is required — restored the previous text.", { exact: true })
  ).toBeVisible();
});

test("shoebox selection: keyboard-togglable checkboxes, select all / clear, camera affordances", async ({ page }, testInfo) => {
  await signInAs(page, email("select", testInfo));
  await uploadReceipts(page, [
    await makeReceiptFixture("uxj-sel-1.jpg"),
    await makeReceiptFixture("uxj-sel-2.jpg"),
  ]);

  const listRes = await page.request.get("/api/receipts");
  const { receipts } = await listRes.json();
  expect(receipts).toHaveLength(2);
  const ids: string[] = receipts.map((r: { id: string }) => r.id);
  const selects = ids.map((id) => page.getByTestId(`receipt-select-${id}`));

  for (const sel of selects) {
    await expect(sel).toHaveRole("checkbox");
    await expect(sel).toHaveAttribute("aria-checked", "false");
  }

  // Space and Enter toggle the focused control without navigating anywhere.
  await selects[0].focus();
  await page.keyboard.press("Space");
  await expect(selects[0]).toHaveAttribute("aria-checked", "true");
  await expect(page).toHaveURL("/");
  await page.keyboard.press("Enter");
  await expect(selects[0]).toHaveAttribute("aria-checked", "false");
  await expect(page).toHaveURL("/");

  // Select all → both checked; Clear → both unchecked.
  await page.getByTestId("select-all-receipts").click();
  for (const sel of selects) await expect(sel).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("clear-selection").click();
  for (const sel of selects) await expect(sel).toHaveAttribute("aria-checked", "false");

  // Camera capture path exists; the dedicated button is phone-width only.
  const cameraInput = page.getByTestId("camera-input");
  await expect(cameraInput).toBeAttached();
  await expect(cameraInput).toHaveAttribute("capture", "environment");
  const cameraButton = page.getByTestId("camera-button");
  await expect(cameraButton).toBeAttached();
  const width = page.viewportSize()?.width ?? 1280;
  if (width < 640) {
    await expect(cameraButton).toBeVisible();
  } else {
    // Phone-only affordance: the responsive hiding lives on a plain wrapper
    // div because `.btn-secondary` is unlayered CSS and would out-cascade a
    // same-element `sm:hidden` utility (Tailwind v4 layering gotcha).
    await expect(cameraButton).toBeHidden();
  }
});

test("delete confirm names the receipt and Escape backs out safely", async ({ page }, testInfo) => {
  await signInAs(page, email("delete", testInfo));
  await uploadReceipts(page, [await makeReceiptFixture("uxj-delete-me.jpg")]);

  await page.getByRole("button", { name: "Delete uxj-delete-me.jpg" }).click();
  const dialog = page.getByTestId("delete-receipt-confirm");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("uxj-delete-me.jpg");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // Nothing was deleted.
  await expect(page.locator('[data-testid^="receipt-card-"]')).toHaveCount(1);
});

test("Escape closes the Category Guide", async ({ page }, testInfo) => {
  await signInAs(page, email("escape", testInfo));
  await uploadReceipts(page, [await makeReceiptFixture("uxj-guide.jpg")]);
  await createClaimFromAllReceipts(page);

  await page.getByTestId("browse-categories").first().click();
  await expect(page.getByTestId("category-guide")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("category-guide")).toHaveCount(0);
});

test("a picked-but-unsaved photo survives a reload via the prepare dialog", async ({ page }, testInfo) => {
  // beforeunload guard fires a browser dialog on reload when the page has
  // user activation — accept it either way.
  page.on("dialog", (d) => d.accept());
  await signInAs(page, email("restore", testInfo));

  const fixture = await makeReceiptFixture("uxj-restore.jpg");
  await shoeboxReady(page);
  await page.getByTestId("file-input").setInputFiles(fixture);
  await expect(page.getByTestId("upload-note")).toBeVisible();
  // The IndexedDB stash is fire-and-forget at pick time — give it a beat
  // before killing the page.
  await page.waitForTimeout(500);

  await page.reload();

  // The prepare dialog comes back, flagged as recovered.
  await expect(page.getByTestId("upload-note")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("restored-photo-note")).toBeVisible();
  await expect(
    page.getByText("Recovered from your last visit — this photo hadn't been saved yet.")
  ).toBeVisible();

  // Drain the queue so the stash row is cleared for later tests.
  await page.getByTestId("upload-note-confirm").click();
  await expect(page.getByTestId("upload-note")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('[data-testid^="receipt-card-"]')).toHaveCount(1, { timeout: 20_000 });
});

test("sign-in honors a same-origin ?return= path", async ({ page }, testInfo) => {
  await page.goto("/signin?return=/claims");
  await page.getByTestId("dev-email").fill(email("return-ok", testInfo));
  await page.getByTestId("dev-name").fill("Return Tester");
  await page.getByTestId("dev-signin").click();
  await page.waitForURL((u) => u.pathname === "/claims");
});

test("sign-in rejects a protocol-relative ?return=", async ({ page }, testInfo) => {
  await page.goto("/signin?return=//evil.example");
  await page.getByTestId("dev-email").fill(email("return-evil", testInfo));
  await page.getByTestId("dev-name").fill("Return Tester");
  await page.getByTestId("dev-signin").click();
  // Rejected → lands on the app root, same origin.
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.getByRole("heading", { name: "Receipts" })).toBeVisible();
});

test("review receipt image zooms and a drag on it still scrolls the page", async ({ page }, testInfo) => {
  // Narrow-but-tall: single column (image at full width), page long enough
  // to scroll, viewport not `short:` (max-height 500) so the clamp is roomy.
  await page.setViewportSize({ width: 700, height: 900 });
  await signInAs(page, email("panzoom", testInfo));
  await uploadReceipts(page, [await makeReceiptFixture("uxj-panzoom.jpg")]);
  await createClaimFromAllReceipts(page);

  const img = page.locator('[data-testid^="receipt-image-"]');
  const stage = page.getByTestId("pan-zoom-stage");
  await expect(img).toBeVisible();
  // The wide fixture fully fits its window, so the initial view is the plain
  // contain fit — identity transform, and nothing to drag → no grab cursor.
  await expect(img).toHaveCSS("transform", /matrix\(1, 0, 0, 1, 0, 0\)|none/);
  await expect(stage).toHaveCSS("cursor", "default");
  const box = (await stage.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // On a fitted image, the surface owns touch — a drag must chain into the
  // page scroll (this was dead on mobile: a nested scroller ate it).
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 220, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => document.scrollingElement!.scrollTop))
    .toBeGreaterThan(100);
  await page.evaluate(() => document.scrollingElement!.scrollTo(0, 0));

  // Double-click zooms about the point; now there's something to drag.
  await stage.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(img).toHaveCSS("transform", /matrix\(2\.5,/);
  await expect(stage).toHaveCSS("cursor", "grab");

  // Zoomed drag pans the image (translate changes) instead of scrolling.
  const before = await img.evaluate((el) => getComputedStyle(el).transform);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 60, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => img.evaluate((el) => getComputedStyle(el).transform)).not.toBe(before);

  // The preset button is always present (−/+ never shift for it): from a
  // freehand zoom it returns to the whole-image fit, then cycles to 2× fit.
  await page.getByTestId("pan-zoom-preset").click();
  await expect(img).toHaveCSS("transform", /matrix\(1, 0, 0, 1, 0, 0\)|none/);
  await expect(stage).toHaveCSS("cursor", "default");
  await page.getByTestId("pan-zoom-preset").click();
  await expect(img).toHaveCSS("transform", /matrix\(2,/);
  await expect(stage).toHaveCSS("cursor", "grab");
});

test("tall receipt opens at the contain fit and the preset button cycles the fits", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await signInAs(page, email("panzoom-tall", testInfo));
  // Far taller than the 75dvh clamp window at any column width.
  await uploadReceipts(page, [await makeReceiptFixture("uxj-panzoom-tall.jpg", { heightPx: 3000 })]);
  await createClaimFromAllReceipts(page);

  const img = page.locator('[data-testid^="receipt-image-"]');
  const stage = page.getByTestId("pan-zoom-stage");
  const preset = page.getByTestId("pan-zoom-preset");
  await expect(img).toBeVisible();
  const scaleOf = () => img.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);

  // Initial view: the whole receipt fits the window — scaled well below 1
  // (fit height), nothing to drag, and − can't go below the contain fit.
  const contain = await scaleOf();
  expect(contain).toBeLessThan(0.5);
  await expect(stage).toHaveCSS("cursor", "default");
  await expect(page.getByRole("button", { name: "Zoom out" })).toBeDisabled();
  await expect(preset).toHaveAttribute("data-preset", "fitWidth");

  // Fit width: full column width, now vertically draggable.
  await preset.click();
  await expect.poll(scaleOf).toBe(1);
  await expect(stage).toHaveCSS("cursor", "grab");
  await expect(preset).toHaveAttribute("data-preset", "zoom2x");

  // 2× of the tighter (more zoomed-in) fit — fit-width here, so exactly 2.
  await preset.click();
  await expect.poll(scaleOf).toBe(2);
  await expect(preset).toHaveAttribute("data-preset", "fitHeight");

  // …and the cycle wraps back to the contain fit.
  await preset.click();
  await expect.poll(scaleOf).toBeCloseTo(contain, 5);
  await expect(stage).toHaveCSS("cursor", "default");
});
