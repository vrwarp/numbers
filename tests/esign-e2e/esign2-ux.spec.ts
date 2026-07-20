import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import sharp from "sharp";

/**
 * E-sign UX follow-up story (runs AFTER esign.spec.ts in the same emulator +
 * SQLite run — alphabetical file order, one shared server, workers=1). It
 * inherits that story's end-state: registry bootstrapped and ON with the
 * allowlist scope, root dana@example.com is admin, Bob Chen an (unpaused)
 * approver, Carol Okafor treasurer; one claim paid and at least one still
 * SUBMITTED to Bob (the phone scene's "Fall Retreat" claim; the duty-pause
 * claim's final state is racy — see the finance test).
 *
 * DEVICE REALITY (verified empirically before this spec was written): every
 * persona here opens a brand-new browser context — a brand-new DEVICE.
 * Charproof custody is deliberately device-local (AMK wrapped to per-device
 * keys in IndexedDB; the emulator's mock passkey lives in per-context
 * localStorage), so the prior story's members can still READ, verify chains,
 * and use every ceremony surface, but any attempt to append a ledger event
 * from this file fails closed with "No signing identity on this device".
 * That is the security design working, not a bug — but it means this story
 * asserts the new ceremony UX up to (and including) the fail-closed boundary
 * rather than completing new signatures. The one scene that needs an
 * already-signed thread (the reject affirmation gate) rides the submitted
 * claim the prior story left in Bob's inbox.
 *
 * Covered UX fixes (commit "E-sign sweep: ceremony safety, identity
 * lifecycle, status clarity"):
 *  - consent gloss, per-stroke signature undo, pending-state scan hint +
 *    voucher directory
 *  - /vouch?c= → /signin?return= threading (the camera-app detour)
 *  - submit dialog: disabled-button hints, Escape-to-close
 *  - reject requires the signed intent affirmation + confirm dialog
 *  - finance: paid-section paid-today bulk select, blank-check-number note
 */

const BASE = "http://localhost:3101";
const EMU_FIRESTORE = process.env.FIRESTORE_EMULATOR_HOST;
const EMU_AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const ROOT_EMAIL = "dana@example.com";

test.describe.configure({ mode: "serial" });
test.skip(
  !EMU_FIRESTORE || !EMU_AUTH,
  "requires the Firebase emulator suite (run via `firebase emulators:exec` — see docs/agent/TESTING.md)"
);

interface Persona {
  context: BrowserContext;
  page: Page;
}

let root: Persona;
let eve: Persona;
let bob: Persona;
let carol: Persona;

// Cross-test state (serial suite).
let eveVouchUrl: string;
let bobClaimId: string;
let receiptJpeg: Buffer;
let receiptSeq = 0;

async function login(
  context: BrowserContext,
  email: string,
  name: string
): Promise<Persona> {
  const page = await context.newPage();
  await page.goto(`${BASE}/signin`);
  await page.fill('[data-testid="dev-email"]', email);
  await page.fill('[data-testid="dev-name"]', name);
  await page.click('[data-testid="dev-signin"]');
  await page.waitForURL(`${BASE}/`);
  return { context, page };
}

async function newPersona(
  browser: import("@playwright/test").Browser,
  email: string,
  name: string
): Promise<Persona> {
  const context = await browser.newContext({ viewport: { width: 480, height: 1000 } });
  return login(context, email, name);
}

async function drawSignature(page: Page) {
  const box = await page.locator('[data-testid="signature-pad"]').boundingBox();
  if (!box) throw new Error("signature pad not visible");
  const cy = box.y + box.height / 2;
  await page.mouse.move(box.x + 30, cy + 20);
  await page.mouse.down();
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    await page.mouse.move(
      box.x + 30 + t * (box.width - 70),
      cy + Math.sin(t * Math.PI * 4) * 22 - t * 14
    );
  }
  await page.mouse.up();
}

/** One short deliberate stroke — enough ink to export, easy to undo. */
async function drawSingleStroke(page: Page) {
  const box = await page.locator('[data-testid="signature-pad"]').boundingBox();
  if (!box) throw new Error("signature pad not visible");
  const cy = box.y + box.height / 2;
  await page.mouse.move(box.x + 40, cy);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, cy + 10, { steps: 6 });
  await page.mouse.up();
}

/** Seed a fully verified single-ministry claim via the API; returns its id. */
async function seedClaim(persona: Persona, event: string): Promise<string> {
  const api = persona.context.request;
  // The PDF gate refuses a blank payee — make sure the seeding persona's
  // profile carries the mailing address the form prints (name comes from
  // the dev login).
  expect(
    (
      await api.patch(`${BASE}/api/profile`, {
        data: { mailingAddress: "123 Main St, San Jose, CA 95110" },
      })
    ).ok()
  ).toBe(true);
  const receiptIds: string[] = [];
  for (const suffix of ["a", "b"]) {
    receiptSeq += 1;
    const res = await api.post(`${BASE}/api/receipts`, {
      multipart: {
        files: {
          name: `ux2-receipt-${receiptSeq}-${suffix}.jpg`,
          mimeType: "image/jpeg",
          buffer: receiptJpeg,
        },
      },
    });
    expect(res.ok()).toBe(true);
    receiptIds.push((await res.json()).receipts[0].id);
  }
  const created = await (
    await api.post(`${BASE}/api/reimbursements`, { data: { receiptIds } })
  ).json();
  const id = created.reimbursement.id as string;
  await api.patch(`${BASE}/api/reimbursements/${id}`, {
    data: { singleMinistry: true, claimMinistry: "237 Office Supplies", claimEvent: event },
  });
  const claim = await (await api.get(`${BASE}/api/reimbursements/${id}`)).json();
  for (const item of claim.reimbursement?.lineItems ?? claim.lineItems) {
    await api.patch(`${BASE}/api/line-items/${item.id}`, { data: { isVerified: true } });
  }
  const pdf = await api.post(`${BASE}/api/reimbursements/${id}/pdf`);
  expect(pdf.ok()).toBe(true);
  return id;
}

test.beforeAll(async ({ browser }) => {
  receiptJpeg = await sharp({
    create: { width: 640, height: 900, channels: 3, background: { r: 225, g: 240, b: 245 } },
  })
    .jpeg()
    .toBuffer();

  root = await newPersona(browser, ROOT_EMAIL, "Pastor Dana");
  eve = await newPersona(browser, "ux2-eve@example.com", "Eve Novak");
});

test.afterAll(async () => {
  for (const p of [root, eve, bob, carol]) {
    await p?.context.close().catch(() => {});
  }
});

test("enrollment wizard: consent gloss, per-stroke undo, pending voucher directory", async () => {
  test.setTimeout(180_000);

  // Scope is still "allowlist" (the prior story never widened it), so the
  // admin grants Eve access first — a plain admin API, no key custody needed.
  await root.page.goto(`${BASE}/members`);
  await root.page.waitForSelector('[data-testid="members-directory"]', { timeout: 30_000 });
  const eveRow = root.page.locator('[data-testid="members-directory"] li', {
    hasText: "ux2-eve@example.com",
  });
  await eveRow.locator('[data-testid^="allow-"]').click();
  await expect(eveRow.locator('[data-testid^="disallow-"]')).toBeVisible({ timeout: 15_000 });

  await eve.page.goto(`${BASE}/profile`);
  await eve.page.click('[data-testid="enable-signing"]', { timeout: 30_000 });

  // Consent step: the plain-language gloss is shown beside (never instead
  // of) the hash-bound English consent text.
  await expect(
    eve.page.getByText("In short: you agree that signing in this app counts", { exact: false })
  ).toBeVisible();
  await eve.page.check('[data-testid="consent-checkbox"]');
  await eve.page.click('[data-testid="consent-next"]');
  await eve.page.waitForSelector('[data-testid="signature-pad"]');

  // Draw step: undo starts disabled (nothing to undo), and so does finish.
  const undo = eve.page.locator('[data-testid="signature-undo"]');
  const finish = eve.page.locator('[data-testid="finish-enroll"]');
  await expect(undo).toBeDisabled();
  await expect(finish).toBeDisabled();

  // One stroke of ink enables both…
  await drawSingleStroke(eve.page);
  await expect(undo).toBeEnabled();
  await expect(finish).toBeEnabled();

  // …and undoing the only stroke empties the pad again (export goes null).
  await undo.click();
  await expect(finish).toBeDisabled();
  await expect(undo).toBeDisabled();

  // Real signature, finish enrollment.
  await drawSignature(eve.page);
  await expect(finish).toBeEnabled();
  await finish.click();

  // Pending state: status chip, the camera-app warning, and the directory of
  // members who can vouch (attested members from the prior story).
  const link = eve.page.locator('a[href*="/vouch?c="]');
  await expect(link).toBeVisible({ timeout: 30_000 });
  eveVouchUrl = (await link.getAttribute("href"))!;
  await expect(eve.page.getByText("Waiting for confirmation")).toBeVisible();
  await expect(eve.page.locator('[data-testid="scan-hint"]')).toBeVisible();
  const directory = eve.page.locator('[data-testid="voucher-directory"]');
  await expect(directory).toBeVisible({ timeout: 30_000 });
  await expect(directory).toContainText("Bob Chen");
});

test("a logged-out vouch link threads through /signin?return= to the loaded candidate", async ({
  browser,
}) => {
  test.setTimeout(240_000);

  // The voucher scanned Eve's QR with their phone's CAMERA APP: the link
  // opens in a logged-out browser. The candidate payload must survive the
  // sign-in detour instead of stranding the voucher on the scanner idle
  // state (the pre-fix behavior).
  const anon = await browser.newContext({ viewport: { width: 480, height: 1000 } });
  const anonPage = await anon.newPage();
  await anonPage.goto(eveVouchUrl);
  await anonPage.waitForURL(/\/signin\?return=/, { timeout: 30_000 });
  expect(anonPage.url()).toContain(encodeURIComponent("/vouch?c="));

  // Dev-login as the root (same email = same account). She lands back on
  // /vouch WITH Eve loaded — the candidate card, not the scanner.
  await anonPage.fill('[data-testid="dev-email"]', ROOT_EMAIL);
  await anonPage.fill('[data-testid="dev-name"]', "Pastor Dana");
  await anonPage.click('[data-testid="dev-signin"]');
  await anonPage.waitForURL(/\/vouch\?c=/, { timeout: 30_000 });
  await expect(anonPage.locator('[data-testid="vouch-subject-name"]')).toHaveText("Eve Novak", {
    timeout: 30_000,
  });
  await expect(anonPage.locator('[data-testid="vouch-confirm"]')).toBeVisible();
  await expect(anonPage.locator('[data-testid="scan-open"]')).toHaveCount(0);

  // Custody boundary: this browser context is a NEW DEVICE for the root —
  // her signing key lives only on the (long-gone) device that bootstrapped
  // the registry. The ceremony must fail CLOSED: a clear error, no vouch
  // event, and the candidate stays pending. (Completing the vouch — flipping
  // Eve to attested — is impossible from a fresh context by design; see the
  // file-top note.)
  await anonPage.check('[data-testid="vouch-confirm"]');
  await anonPage.click('[data-testid="vouch-submit"]');
  await expect(anonPage.getByText("No signing identity on this device")).toBeVisible({
    timeout: 30_000,
  });
  await expect(anonPage.locator('[data-testid="vouch-done"]')).toHaveCount(0);
  await anon.close();

  // Nothing landed on the roster: Eve is still waiting.
  await eve.page.goto(`${BASE}/profile`);
  await expect(eve.page.getByText("Waiting for confirmation")).toBeVisible({ timeout: 30_000 });
});

test("submit ceremony: disabled-button hints walk the signer forward; Escape closes", async ({
  browser,
}) => {
  test.setTimeout(240_000);

  // Bob (attested in the prior story, saved signature on file) seeds his own
  // claim — the ceremony SURFACE needs mirror attestation, not device custody.
  bob = await newPersona(browser, "bob@example.com", "Bob Chen");
  bobClaimId = await seedClaim(bob, "UX Story 2026");

  await bob.page.goto(`${BASE}/claims/${bobClaimId}`);
  await bob.page.click('[data-testid="submit-for-approval"]');
  await bob.page.waitForSelector('[data-testid="document-sign-field"]', { timeout: 30_000 });

  // No approver picked: the sign button is disabled with pointer-events off,
  // so the tap lands on its wrapper — which reveals the first missing
  // requirement instead of doing nothing.
  await expect(bob.page.locator('[data-testid="submit-place-hint"]')).toHaveCount(0);
  await bob.page.getByTestId("sign-submit").locator("..").click();
  await expect(bob.page.locator('[data-testid="submit-place-hint"]')).toHaveText(
    "Pick an approver first."
  );

  // Escape closes the ceremony dialog (the key handler lives on the dialog
  // container, so focus a field inside it first — as a keyboard user would).
  await bob.page.click('[data-testid="typed-name"]');
  await bob.page.keyboard.press("Escape");
  await expect(bob.page.locator('[data-testid="sign-submit"]')).toHaveCount(0);

  // Re-open: the hints walk the signer through each remaining requirement.
  await bob.page.click('[data-testid="submit-for-approval"]');
  await bob.page.waitForSelector('[data-testid="document-sign-field"]', { timeout: 30_000 });
  await bob.page.selectOption('[data-testid="approver-select"]', {
    label: "Carol Okafor (Treasurer)",
  });
  // With an approver picked but no signature placed, the placement hint
  // shows unprompted (it is the least obvious requirement).
  await expect(bob.page.locator('[data-testid="submit-place-hint"]')).toHaveText(
    "Press and hold on the form above to place your signature first."
  );
  // Long-press places the stamp; the typed name arrived prefilled.
  await bob.page.click('[data-testid="tap-to-sign"]', { delay: 900 });
  await expect(bob.page.locator('[data-testid="typed-name"]')).toHaveValue("Bob Chen");
  await bob.page.getByTestId("sign-submit").locator("..").click();
  await expect(bob.page.locator('[data-testid="submit-place-hint"]')).toHaveText(
    "Tick the agreement box first."
  );
  await bob.page.check('[data-testid="intent-checkbox"]');
  // Every requirement satisfied: the hint retires and the button arms.
  await expect(bob.page.locator('[data-testid="submit-place-hint"]')).toHaveCount(0);
  await expect(bob.page.locator('[data-testid="sign-submit"]')).toBeEnabled();

  // Stop at the custody boundary (signing from this fresh device would fail
  // closed) — cancel out and confirm the claim is untouched.
  await bob.page.getByRole("button", { name: "Cancel" }).click();
  await expect(bob.page.locator('[data-testid="sign-submit"]')).toHaveCount(0);
  await expect(bob.page.locator('[data-testid="claim-status"]')).toHaveText("Ready to submit");
});

test("reject demands the same signed intent affirmation as approve", async () => {
  test.setTimeout(240_000);

  // The prior story's phone scene left one claim SUBMITTED to Bob ("Fall
  // Retreat") — the live thread this decision-gate scene rides on.
  const inbox = await (await bob.context.request.get(`${BASE}/api/approvals`)).json();
  const submitted = ((inbox.claims ?? []) as { id: string; status: string }[]).filter(
    (c) => c.status === "submitted"
  );
  expect(submitted.length).toBeGreaterThan(0);
  const claimId = submitted[0].id;

  await bob.page.goto(`${BASE}/approvals`);
  await bob.page.waitForSelector(`[data-testid="approval-${claimId}"]`, { timeout: 30_000 });
  await bob.page.click(`[data-testid="approval-${claimId}"] button`);
  // The full fail-closed verification passes (read-only crypto) and the
  // stamp surface renders.
  await bob.page.waitForSelector('[data-testid="document-sign-field"]', { timeout: 60_000 });

  // A comment alone is no longer enough — a REJECT is signed into the ledger
  // exactly like an APPROVE, so it carries the same intent affirmation.
  await bob.page.fill('[data-testid="decision-comment"]', "Please split the retreat costs");
  await expect(bob.page.locator('[data-testid="reject-button"]')).toBeDisabled();
  await bob.page.check('[data-testid="decision-intent"]');
  // The typed name prefilled from the verified chain state.
  await expect(bob.page.locator('[data-testid="decision-typed-name"]')).toHaveValue("Bob Chen");
  await expect(bob.page.locator('[data-testid="reject-button"]')).toBeEnabled();
  // Approve stays gated further: it also needs the placed signature stamp.
  await expect(bob.page.locator('[data-testid="approve-button"]')).toBeDisabled();

  // Reject is a one-way door — it now confirms before committing. Cancel at
  // the brink (this fresh device could not sign the ledger event anyway; see
  // the file-top custody note) and confirm nothing changed.
  await bob.page.click('[data-testid="reject-button"]');
  await expect(bob.page.getByText("Reject this claim?")).toBeVisible();
  await expect(bob.page.locator('[data-testid="confirm-dialog-submit"]')).toBeVisible();
  await bob.page.getByRole("button", { name: "Cancel" }).click();
  await expect(bob.page.locator('[data-testid="confirm-dialog-submit"]')).toHaveCount(0);
  await expect(bob.page.locator(`[data-testid="approval-${claimId}"]`)).toBeVisible();
});

test("finance: paid-today bulk select; blank check number is explained", async ({
  browser,
}) => {
  test.setTimeout(240_000);

  // The prior story left Carol the treasurer with one claim marked paid
  // during this run — i.e. paid TODAY — so the paid-today bulk-select link
  // always has rows to grab. An approved-unpaid claim (for
  // the pay-ceremony note) exists only when the duty-pause scene's second
  // approval actually committed — esign.spec.ts asserts it with a bare
  // `getByText("Approved")`, which the paid claim's "Approved {date}" meta
  // line in the decided history satisfies immediately, so that test can
  // navigate away mid-ceremony and leave the claim submitted. Tolerate both
  // end-states rather than replaying a full approve→pay chain here.
  carol = await newPersona(browser, "carol@example.com", "Carol Okafor");
  const finance = await (await carol.context.request.get(`${BASE}/api/finance`)).json();
  const claims = (finance.claims ?? []) as { id: string; status: string; paidAt: string | null }[];
  const sameLocalDay = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    return (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    );
  };
  const paidTodayIds = claims
    .filter((c) => c.status === "paid" && c.paidAt && sameLocalDay(c.paidAt))
    .map((c) => c.id);
  const approvedIds = claims.filter((c) => c.status === "approved").map((c) => c.id);
  expect(paidTodayIds.length).toBeGreaterThan(0);

  await carol.page.goto(`${BASE}/finance`);
  await carol.page.waitForSelector('[data-testid="print-select-today"]', { timeout: 30_000 });
  // The link forecasts its scope: "(n)" = how many claims were paid today.
  await expect(carol.page.locator('[data-testid="print-select-today"]')).toContainText(
    `(${paidTodayIds.length})`
  );
  await carol.page.click('[data-testid="print-select-today"]');
  for (const id of paidTodayIds) {
    await expect(carol.page.locator(`[data-testid="paid-select-${id}"]`)).toHaveAttribute(
      "aria-checked",
      "true"
    );
  }
  // Every paid-today row selected ⇒ the bulk-select link retires and the
  // batch toolbar offers Print selected.
  await expect(carol.page.locator('[data-testid="print-select-today"]')).toHaveCount(0);
  await expect(carol.page.locator('[data-testid="print-selected"]')).toBeVisible();

  // Drop the selection so the floating batch toolbar can't cover the pay
  // ceremony's fields below.
  await carol.page.getByRole("button", { name: "Clear" }).click();
  await expect(carol.page.locator('[data-testid="print-selected"]')).toHaveCount(0);

  // Open the approved claim's pay ceremony: with the check-number field
  // empty, the note explains blank is fine for non-check payments. Skipped
  // when the prior story's race (above) left no approved claim behind.
  if (approvedIds.length === 0) {
    test.info().annotations.push({
      type: "note",
      description:
        "no approved-unpaid claim in the inherited end-state (duty-pause approve raced) — pay-ceremony note not exercised this run",
    });
    return;
  }
  await carol.page.click(`[data-testid="finance-${approvedIds[0]}"] button`);
  await carol.page.waitForSelector('[data-testid="check-number"]', { timeout: 60_000 });
  await expect(carol.page.locator('[data-testid="check-number"]')).toHaveValue("");
  await expect(carol.page.locator('[data-testid="no-check-note"]')).toBeVisible();
  // Typing a check number retires the note; clearing brings it back.
  await carol.page.fill('[data-testid="check-number"]', "2048");
  await expect(carol.page.locator('[data-testid="no-check-note"]')).toHaveCount(0);
  await carol.page.fill('[data-testid="check-number"]', "");
  await expect(carol.page.locator('[data-testid="no-check-note"]')).toBeVisible();
});
