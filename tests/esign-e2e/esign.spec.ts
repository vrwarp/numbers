import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import sharp from "sharp";

/**
 * E-sign e2e against the REAL Firestore backend (docs/agent/TESTING.md):
 * the committed CI version of the full walkthrough — no ESIGN_MOCK anywhere.
 * Runs under `firebase emulators:exec` (Dockerfile.e2e / `test:e2e:esign`),
 * which provides FIRESTORE_EMULATOR_HOST + FIREBASE_AUTH_EMULATOR_HOST; the
 * webServer (tests/esign-e2e/start-server.sh) relays them so the browser
 * drives real charproof custody, real Firestore transactions/snapshots, and
 * the production firestore.rules.
 *
 * One serial story, four humans and seven browser contexts:
 * bootstrap → enroll/vouch/roles → claim → submit/approve/pay → verify →
 * phone joins by typed code and signs → printed recovery sheet → tablet
 * recovers by phrase → phone revoked (AMK rotation asserted SERVER-side) →
 * lost-everything start-over → re-vouch supersedes the key → history stands.
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
let alice: Persona;
let bob: Persona;
let carol: Persona;
let alicePhone: Persona;
let aliceTablet: Persona;
let aliceNew: Persona;
let evan: Persona;

// Cross-test state (serial suite).
let bobVouchUrl: string;
let carolVouchUrl: string;
let aliceVouchUrl: string;
let claimId: string;
let claim2Id: string;
let publicToken: string;
let phoneDeviceId: string;
let phraseWords: string[];
let receiptJpeg: Buffer;

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

/** Consent → draw → pending-QR enrollment; returns the /vouch URL. */
async function enroll(persona: Persona): Promise<string> {
  await persona.page.goto(`${BASE}/profile`);
  await persona.page.click('[data-testid="enable-signing"]');
  await persona.page.check('[data-testid="consent-checkbox"]');
  await persona.page.click('[data-testid="consent-next"]');
  await persona.page.waitForSelector('[data-testid="signature-pad"]');
  await drawSignature(persona.page);
  await persona.page.click('[data-testid="finish-enroll"]');
  const link = persona.page.locator('a[href*="/vouch?c="]');
  await expect(link).toBeVisible({ timeout: 30_000 });
  return (await link.getAttribute("href"))!;
}

/**
 * Root sets an attested member's role via the role select + its confirm
 * dialog. The select flips optimistically on pick, so the completion signal is
 * the dialog closing (which the component does only after the roster event is
 * signed and reported) — not the value.
 */
async function grantRole(page: Page, name: string, role: "approver" | "treasurer") {
  // Role grants live on the Members page (root-signed roster events).
  await page.goto(`${BASE}/members`);
  await page.waitForSelector('[data-testid="members-directory"]', { timeout: 30_000 });
  await page.locator(`li:has-text('${name}') select`).selectOption(role);
  await page.click('[data-testid="confirm-dialog-submit"]');
  await expect(page.locator('[data-testid="confirm-dialog-submit"]')).toBeHidden({
    timeout: 30_000,
  });
  await expect(page.locator(`li:has-text('${name}') select`)).toHaveValue(role);
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
  for (const name of ["receipt-a.jpg", "receipt-b.jpg"]) {
    const res = await api.post(`${BASE}/api/receipts`, {
      multipart: { files: { name, mimeType: "image/jpeg", buffer: receiptJpeg } },
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

/**
 * Exercise the signing-preview gestures on whatever document-sign-field is open
 * (docs: DocumentSignField). Asserts the three behaviours the surface adds:
 *   1. a QUICK tap does NOT sign — signing is a deliberate long-press now, so
 *      the tab stays and the submit button stays disabled;
 *   2. the zoom buttons zoom (the % readout and CSS transform change, reset
 *      restores 100%);
 *   3. drag-to-pan moves the content once zoomed.
 * Leaves the view reset to 100% so the caller can hold-to-sign cleanly.
 */
async function verifyPreviewGestures(page: Page, submitTestId: string) {
  const content = page.locator('[data-testid="sign-viewport-content"]');
  const transform = () => content.evaluate((el) => getComputedStyle(el).transform);

  // 1. Quick tap must not sign (long-press gate): the tab stays, no stamp is
  //    placed, and the ceremony's commit button stays disabled.
  await page.click('[data-testid="tap-to-sign"]');
  await expect(page.locator('[data-testid="tap-to-sign"]')).toBeVisible();
  await expect(page.locator('[data-role="stamp"]')).toHaveCount(0);
  await expect(page.locator(`[data-testid="${submitTestId}"]`)).toBeDisabled();

  // 2. Zoom buttons.
  await expect(page.locator('[data-testid="zoom-reset"]')).toHaveText("100%");
  const atRest = await transform();
  await page.click('[data-testid="zoom-in"]');
  await expect(page.locator('[data-testid="zoom-reset"]')).not.toHaveText("100%");
  const zoomedTransform = await transform();
  expect(zoomedTransform).not.toBe(atRest);

  // 3. Drag-to-pan while zoomed (start away from the tab so it pans, not signs).
  const box = (await page.locator('[data-testid="document-sign-field"]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height * 0.3, { steps: 8 });
  await page.mouse.up();
  expect(await transform()).not.toBe(zoomedTransform);

  // Back to 100% for the caller's hold-to-sign.
  await page.click('[data-testid="zoom-reset"]');
  await expect(page.locator('[data-testid="zoom-reset"]')).toHaveText("100%");
}

/** Hold-to-sign submit ceremony for the claim currently open at /claims/:id. */
async function submitForApproval(persona: Persona, id: string) {
  await persona.page.goto(`${BASE}/claims/${id}`);
  await persona.page.click('[data-testid="submit-for-approval"]');
  await persona.page.waitForSelector('[data-testid="document-sign-field"]', { timeout: 30_000 });
  // The option label renders the role through Common.role.* ("Approver").
  await persona.page.selectOption('[data-testid="approver-select"]', { label: "Bob Chen (Approver)" });
  await persona.page.check('[data-testid="intent-checkbox"]');
  // Zoom/pan/long-press gestures behave before we actually sign.
  await verifyPreviewGestures(persona.page, "sign-submit");
  // Signing is a long-press now: hold the tab past HOLD_MS via click delay.
  await persona.page.click('[data-testid="tap-to-sign"]', { delay: 900 });
  await persona.page.click('[data-testid="sign-submit"]');
  await expect(persona.page.getByText("Awaiting approval").first()).toBeVisible({
    timeout: 30_000,
  });
  await persona.page.waitForSelector('[data-testid="thread-signatures"]', { timeout: 30_000 });
}

test.beforeAll(async ({ browser }) => {
  // Any valid JPEG works — AI_MOCK extraction is deterministic and never
  // reads pixels. Generated here so nothing binary is committed.
  receiptJpeg = await sharp({
    create: { width: 640, height: 900, channels: 3, background: { r: 245, g: 240, b: 225 } },
  })
    .jpeg()
    .toBuffer();

  root = await newPersona(browser, ROOT_EMAIL, "Pastor Dana");
  alice = await newPersona(browser, "alice@example.com", "Alice Rivera");
  bob = await newPersona(browser, "bob@example.com", "Bob Chen");
  carol = await newPersona(browser, "carol@example.com", "Carol Okafor");
});

test.afterAll(async () => {
  for (const p of [root, alice, bob, carol, alicePhone, aliceTablet, aliceNew, evan]) {
    await p?.context.close().catch(() => {});
  }
});

test("root bootstraps the registry, switched off, then turns it on", async () => {
  test.setTimeout(120_000);
  await root.page.goto(`${BASE}/profile`);
  await root.page.click('[data-testid="esign-bootstrap"]');
  // A5: bootstrap leaves the master switch OFF.
  await expect(root.page.locator('[data-testid="esign-switch"]')).toBeVisible({
    timeout: 30_000,
  });
  await expect(root.page.getByText("Electronic signing is OFF")).toBeVisible();
  await root.page.click('[data-testid="esign-switch"]');
  await expect(root.page.getByText("Electronic signing is ON")).toBeVisible({ timeout: 30_000 });
  await expect(root.page.getByText("Ready to sign")).toBeVisible({ timeout: 30_000 });
  // The root's bootstrap skips the wizard — add her ink separately.
  await root.page.click('[data-testid="add-signature"]');
  await root.page.waitForSelector('[data-testid="signature-pad"]');
  await drawSignature(root.page);
  await root.page.click('[data-testid="save-signature"]');
  await expect(root.page.locator('[data-testid="redraw-signature"]')).toBeVisible({
    timeout: 30_000,
  });
});

test("rollout is allowlist-scoped by default; the admin allows the pilot group", async () => {
  test.setTimeout(180_000);
  // A8: with the switch ON but the scope at its "allowlist" default, an
  // un-allowed member sees NOTHING e-sign related…
  await alice.page.goto(`${BASE}/profile`);
  await expect(alice.page.getByText("Full name")).toBeVisible({ timeout: 30_000 });
  await expect(alice.page.locator('[data-testid="signing-identity-card"]')).toHaveCount(0);
  // …and the enrollment route refuses server-side (the UI gate is cosmetic).
  const denied = await alice.context.request.post(`${BASE}/api/esign/identity`, {
    data: { signatureImage: "" },
  });
  expect(denied.status()).toBe(409);
  expect((await denied.json()).code).toBe("esign.notAllowed");

  // Per-person grants live on the Members page (the profile card keeps the
  // scope switch and points there); allow the pilot trio.
  await root.page.goto(`${BASE}/members`);
  await root.page.waitForSelector('[data-testid="members-directory"]', { timeout: 30_000 });
  for (const email of ["alice@example.com", "bob@example.com", "carol@example.com"]) {
    const row = root.page.locator('[data-testid="members-directory"] li', { hasText: email });
    await row.locator('[data-testid^="allow-"]').click();
    await expect(row.locator('[data-testid^="disallow-"]')).toBeVisible({ timeout: 15_000 });
  }

  // Alice is in: the card appears with the enroll call-to-action.
  await alice.page.goto(`${BASE}/profile`);
  await expect(alice.page.locator('[data-testid="enable-signing"]')).toBeVisible({
    timeout: 30_000,
  });
});

test("members enroll; vouches + roles attest them", async () => {
  test.setTimeout(240_000);
  bobVouchUrl = await enroll(bob);
  // Pending members can't vouch, so the nav's Vouch tab isn't offered yet.
  await expect(bob.page.getByTestId("nav-tab-vouch")).toHaveCount(0);
  carolVouchUrl = await enroll(carol);
  aliceVouchUrl = await enroll(alice);

  // Root vouches Bob (approver+ ⇒ instant), grants approver.
  await root.page.goto(bobVouchUrl);
  await root.page.check('[data-testid="vouch-confirm"]');
  await root.page.click('[data-testid="vouch-submit"]');
  await root.page.waitForSelector('[data-testid="vouch-done"]', { timeout: 30_000 });
  await grantRole(root.page, "Bob Chen", "approver");

  await root.page.goto(carolVouchUrl);
  await root.page.check('[data-testid="vouch-confirm"]');
  await root.page.click('[data-testid="vouch-submit"]');
  await root.page.waitForSelector('[data-testid="vouch-done"]', { timeout: 30_000 });
  await grantRole(root.page, "Carol Okafor", "treasurer");

  // Bob (now approver) vouches Alice — one vouch tips it.
  await bob.page.goto(aliceVouchUrl);
  // Attested since the root's vouch, so this navigation grew a Vouch nav tab.
  await expect(bob.page.getByTestId("nav-tab-vouch")).toBeVisible({ timeout: 30_000 });
  await bob.page.check('[data-testid="vouch-confirm"]');
  await bob.page.click('[data-testid="vouch-submit"]');
  await bob.page.waitForSelector('[data-testid="vouch-done"]', { timeout: 30_000 });
  // Auto-refresh (subscribeRoster): Alice's profile has stayed open since she
  // enrolled, so Bob's vouch reaches her over the roster ledger's live
  // subscription and her card flips pending → attested with NO reload.
  await expect(alice.page.getByText("Ready to sign")).toBeVisible({ timeout: 60_000 });
});

test("in-page QR scanner appears for vouchers and degrades without a camera", async () => {
  // An attested member opening the nav's Vouch tab with no identity in the
  // URL gets the in-page camera scanner — the multi-browser-friendly path
  // that keeps vouching inside the browser holding their key and session.
  // (goto, not a tab click: bob sits on /vouch?c=… whose done-state would
  // survive a same-route client-side navigation)
  await bob.page.goto(`${BASE}/vouch`);
  const scanOpen = bob.page.locator('[data-testid="scan-open"]');
  await expect(scanOpen).toBeVisible({ timeout: 30_000 });

  // Simulate the common church-device case: camera blocked or absent. The
  // override lives only on this document — the next goto restores the native
  // getUserMedia, so it can't leak into later ceremonies.
  await bob.page.evaluate(() => {
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    }
  });
  await scanOpen.click();
  await expect(bob.page.locator('[data-testid="scan-error"]')).toBeVisible({ timeout: 30_000 });

  // The manual fallback (pick from the list + full fingerprint) is still offered.
  await expect(bob.page.getByText("Or pick them and type their fingerprint")).toBeVisible();
});

test("submit → approve → pay, fail-closed ceremonies throughout", async () => {
  test.setTimeout(300_000);
  claimId = await seedClaim(alice, "VBS 2026");
  await submitForApproval(alice, claimId);

  // Bob's decision ceremony: approve enables only after chain verify + hold.
  await bob.page.goto(`${BASE}/approvals`);
  await bob.page.waitForSelector(`[data-testid="approval-${claimId}"]`, { timeout: 30_000 });
  await bob.page.click(`[data-testid="approval-${claimId}"] button`);
  await bob.page.waitForSelector('[data-testid="document-sign-field"]', { timeout: 30_000 });
  await bob.page.check('[data-testid="decision-intent"]');
  await verifyPreviewGestures(bob.page, "approve-button");
  await bob.page.click('[data-testid="tap-to-sign"]', { delay: 900 });
  await bob.page.waitForSelector('[data-testid="approve-button"]:not([disabled])', {
    timeout: 30_000,
  });
  await bob.page.click('[data-testid="approve-button"]');
  await expect(bob.page.getByText("Approved", { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Carol marks paid with a check number.
  await carol.page.goto(`${BASE}/finance`);
  await carol.page.click(`[data-testid="finance-${claimId}"] button`);
  await carol.page.waitForSelector('[data-testid="thread-signatures"]', { timeout: 30_000 });
  await carol.page.fill('[data-testid="check-number"]', "1042");
  await carol.page.check('[data-testid="paid-intent"]');
  await carol.page.waitForSelector('[data-testid="mark-paid-button"]:not([disabled])', {
    timeout: 30_000,
  });
  await carol.page.click('[data-testid="mark-paid-button"]');
  await expect(carol.page.getByText("Paid", { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Treasurer batch-print (Finance › Paid): the paid row carries a select
  // checkbox and its full date history in the meta line; selecting reveals the
  // floating toolbar with Print all.
  await expect(carol.page.getByTestId(`paid-select-${claimId}`)).toBeVisible({ timeout: 30_000 });
  await expect(carol.page.getByTestId(`paid-${claimId}`)).toContainText("Submitted");
  await carol.page.click(`[data-testid="paid-select-${claimId}"]`);
  await expect(carol.page.getByTestId("print-all")).toBeVisible();
  // The button opens the combined PDF in a new tab via a blob URL; assert the
  // POST /api/finance/print endpoint directly — forms-only, then the full
  // variant with receipts + the signature certificate cover.
  for (const opts of [
    { includeReceipts: false, includeCertificate: false },
    { includeReceipts: true, includeCertificate: true },
  ]) {
    const res = await carol.context.request.post(`${BASE}/api/finance/print`, {
      data: { ids: [claimId], ...opts },
    });
    expect(res.ok(), JSON.stringify(opts)).toBe(true);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    const body = await res.body();
    expect(body.length).toBeGreaterThan(1000);
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }

  // Owner sees the full signed thread; the public link verifies in-browser.
  await alice.page.goto(`${BASE}/claims/${claimId}`);
  // A clean chain is silent on the main path; the reassurance lives inside the
  // Audit details disclosure. Open it to confirm verification passed.
  await alice.page.getByTestId("audit-details").first().getByText("Audit details").click();
  await expect(alice.page.getByTestId("audit-status").first()).toContainText(
    "Everything checks out",
    { timeout: 30_000 }
  );
  const full = await (
    await alice.context.request.get(`${BASE}/api/reimbursements/${claimId}`)
  ).json();
  publicToken = (full.reimbursement ?? full).publicToken;
  const anon = await alice.context.browser()!.newContext({
    viewport: { width: 480, height: 1100 },
  });
  const anonPage = await anon.newPage();
  await anonPage.goto(`${BASE}/v/${publicToken}`);
  await expect(anonPage.getByText("Confirmed genuine")).toBeVisible({ timeout: 30_000 });
  await anon.close();
});

test("duty pause: a paused approver leaves the picker; assigned work stays decidable", async () => {
  test.setTimeout(300_000);

  // Bob switches his approver duty off on his profile (A10).
  await bob.page.goto(`${BASE}/profile`);
  await bob.page.waitForSelector('[data-testid="duty-approvalsPaused"]', { timeout: 30_000 });
  await bob.page.click('[data-testid="duty-approvalsPaused-toggle"]');
  await expect(bob.page.getByText("not taking new approval requests")).toBeVisible({
    timeout: 30_000,
  });

  // The members payload carries the flag, and the picker drops him — while
  // Carol (treasurer = approver-or-above, not paused) stays offered.
  const members = await (
    await alice.context.request.get(`${BASE}/api/esign/members`)
  ).json();
  const bobRow = members.members.find((m: { email: string }) => m.email === "bob@example.com");
  expect(bobRow.approvalsPaused).toBe(true);
  const pausedClaim = await seedClaim(alice, "Duty Pause 2026");
  await alice.page.goto(`${BASE}/claims/${pausedClaim}`);
  await alice.page.click('[data-testid="submit-for-approval"]');
  await alice.page.waitForSelector('[data-testid="approver-select"]', { timeout: 30_000 });
  await expect(
    alice.page.locator('[data-testid="approver-select"] option', { hasText: "Bob Chen" })
  ).toHaveCount(0);
  await expect(
    alice.page.locator('[data-testid="approver-select"] option', { hasText: "Carol Okafor" })
  ).toHaveCount(1);
  await alice.page.getByRole("button", { name: "Cancel" }).click();

  // The picker filter is cosmetic — the preflight is the real gate.
  const denied = await alice.context.request.post(
    `${BASE}/api/reimbursements/${pausedClaim}/submit?preflight=1`,
    { data: { approverUserId: bobRow.userId, typedName: "Alice Rivera" } }
  );
  expect(denied.status()).toBe(409);
  expect((await denied.json()).code).toBe("esign.approverUnavailable");

  // Unpause ⇒ Bob is pickable again; Alice routes the claim to him.
  await bob.page.click('[data-testid="duty-approvalsPaused-toggle"]');
  await expect(bob.page.getByText("Members can pick you as the approver")).toBeVisible({
    timeout: 30_000,
  });
  await submitForApproval(alice, pausedClaim);

  // Bob pauses AGAIN with the claim now assigned. Pausing stops NEW routing
  // only: the claim stays in his inbox behind a notice, Alice's panel names
  // him and flags the pause beside the withdraw/reassign button, and his
  // decision ceremony still works (the ledger would accept it regardless).
  await bob.page.goto(`${BASE}/profile`);
  await bob.page.waitForSelector('[data-testid="duty-approvalsPaused"]', { timeout: 30_000 });
  await bob.page.click('[data-testid="duty-approvalsPaused-toggle"]');
  await expect(bob.page.getByText("not taking new approval requests")).toBeVisible({
    timeout: 30_000,
  });

  await alice.page.goto(`${BASE}/claims/${pausedClaim}`);
  await expect(alice.page.getByTestId("waiting-approver")).toContainText("Bob Chen", {
    timeout: 30_000,
  });
  await expect(alice.page.getByTestId("approver-paused-note")).toBeVisible();
  await expect(alice.page.getByTestId("change-approver")).toBeVisible();

  await bob.page.goto(`${BASE}/approvals`);
  await bob.page.waitForSelector(`[data-testid="approval-${pausedClaim}"]`, { timeout: 30_000 });
  await expect(bob.page.getByTestId("paused-notice")).toBeVisible();
  await bob.page.click(`[data-testid="approval-${pausedClaim}"] button`);
  await bob.page.waitForSelector('[data-testid="document-sign-field"]', { timeout: 30_000 });
  await bob.page.check('[data-testid="decision-intent"]');
  await bob.page.click('[data-testid="tap-to-sign"]', { delay: 900 });
  await bob.page.waitForSelector('[data-testid="approve-button"]:not([disabled])', {
    timeout: 30_000,
  });
  await bob.page.click('[data-testid="approve-button"]');
  await expect(bob.page.getByText("Approved", { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Back on duty for the later scenes (the phone story routes to Bob again).
  await bob.page.goto(`${BASE}/profile`);
  await bob.page.waitForSelector('[data-testid="duty-approvalsPaused"]', { timeout: 30_000 });
  await bob.page.click('[data-testid="duty-approvalsPaused-toggle"]');
  await expect(bob.page.getByText("Members can pick you as the approver")).toBeVisible({
    timeout: 30_000,
  });
});

test("a phone joins by typed 6-digit code and signs a whole claim", async ({ browser }) => {
  test.setTimeout(300_000);
  alicePhone = await newPersona(browser, "alice@example.com", "Alice Rivera");
  await alicePhone.page.goto(`${BASE}/profile`);
  await expect(alicePhone.page.locator('[data-testid="new-device-card"]')).toBeVisible({
    timeout: 45_000,
  });
  await alicePhone.page.click('[data-testid="request-device-auth"]');
  const code = (
    await alicePhone.page.locator('[data-testid="device-code"]').textContent({
      timeout: 30_000,
    })
  )!.trim();
  expect(code).toMatch(/^\d{6}$/);
  phoneDeviceId = (await alicePhone.page.evaluate(() => localStorage.getItem("deviceId")))!;

  // Approval banner on the laptop; the typed code is ENFORCED.
  await alice.page.goto(`${BASE}/claims`);
  await alice.page.waitForSelector('[data-testid="device-request-banner"]', { timeout: 45_000 });
  await alice.page.fill('[data-testid="device-code-input"]', code);
  await alice.page.click('[data-testid="approve-device"]');
  await alice.page.waitForSelector('[data-testid="device-request-banner"]', {
    state: "detached",
    timeout: 30_000,
  });

  // The phone lets itself in — same attested key, no re-vouching.
  await expect(alicePhone.page.getByText("Ready to sign")).toBeVisible({ timeout: 60_000 });
  await expect(alicePhone.page.locator('[data-testid="devices-panel"]')).toBeVisible({
    timeout: 30_000,
  });

  // Signing parity: an entire second claim, submitted from the phone.
  claim2Id = await seedClaim(alicePhone, "Fall Retreat");
  await submitForApproval(alicePhone, claim2Id);
});

test("printed recovery sheet; a tablet recovers by phrase alone", async ({ browser }) => {
  test.setTimeout(240_000);
  await alice.page.goto(`${BASE}/profile`);
  await alice.page.click('[data-testid="setup-phrase"]');
  await alice.page.waitForSelector('[data-testid="download-recovery-pdf"]', { timeout: 30_000 });
  const download = alice.page.waitForEvent("download");
  await alice.page.click('[data-testid="download-recovery-pdf"]');
  expect((await download).suggestedFilename()).toBe("signing-recovery-sheet.pdf");
  phraseWords = await alice.page.$$eval('[data-testid="phrase-words"] li', (els) =>
    els.map((el) => el.textContent!.replace(/^\d+\./, "").trim())
  );
  expect(phraseWords).toHaveLength(24);
  await alice.page.check('[data-testid="recovery-saved-checkbox"]');
  await alice.page.click('[data-testid="phrase-done"]');
  await alice.page.waitForSelector('[data-testid="recovery-nudge"]', {
    state: "detached",
    timeout: 30_000,
  });

  aliceTablet = await newPersona(browser, "alice@example.com", "Alice Rivera");
  await aliceTablet.page.goto(`${BASE}/profile`);
  await aliceTablet.page.click('[data-testid="recover-phrase-option"]', { timeout: 45_000 });
  await aliceTablet.page.fill('[data-testid="recover-phrase-input"]', phraseWords.join(" "));
  await aliceTablet.page.click('[data-testid="recover-phrase-submit"]');
  await expect(aliceTablet.page.getByText("Ready to sign")).toBeVisible({ timeout: 60_000 });
});

test("revoking the phone rotates the AMK server-side and locks it out", async () => {
  test.setTimeout(300_000);
  await alice.page.goto(`${BASE}/profile`);
  await alice.page.waitForSelector('[data-testid="devices-panel"]', { timeout: 30_000 });
  await alice.page.click(`[data-testid="remove-device-${phoneDeviceId}"]`);
  await alice.page.click('[data-testid="remove-device-confirm-confirm"]');
  await alice.page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="remove-device-"]').length === 1,
    { timeout: 60_000 }
  );

  // The UI is a snapshot; assert the rotation COMMITTED in Firestore.
  const signIn = await fetch(
    `http://${EMU_AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.com",
        password: "esign-emulator-password",
        returnSecureToken: true,
      }),
    }
  ).then((r) => r.json() as Promise<{ localId: string }>);
  await expect
    .poll(
      async () => {
        const res = await fetch(
          `http://${EMU_FIRESTORE}/v1/projects/demo-numbers/databases/(default)/documents/users/${signIn.localId}/account_keys/default`,
          { headers: { Authorization: "Bearer owner" } }
        ).then((r) => r.json());
        const devices = Object.keys(res.fields?.devices?.mapValue?.fields ?? {});
        const activeAmk = res.fields?.activeAmkId?.stringValue as string;
        return { count: devices.length, rotated: activeAmk !== "amk_v1", phoneGone: !devices.includes(phoneDeviceId) };
      },
      { timeout: 45_000 }
    )
    .toEqual({ count: 2, rotated: true, phoneGone: true });

  // The phone is out — and everything it signed stays valid.
  await alicePhone.page.goto(`${BASE}/profile`);
  await expect(alicePhone.page.locator('[data-testid="new-device-card"]')).toBeVisible({
    timeout: 60_000,
  });
  await aliceTablet.page.goto(`${BASE}/claims/${claim2Id}`);
  await expect(aliceTablet.page.getByText("Awaiting approval").first()).toBeVisible({
    timeout: 30_000,
  });
  await aliceTablet.page.getByTestId("audit-details").first().getByText("Audit details").click();
  await expect(aliceTablet.page.getByTestId("audit-status").first()).toContainText(
    "Everything checks out",
    { timeout: 30_000 }
  );
});

test("lost everything: start-over + re-vouch supersedes the key; history stands", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  aliceNew = await newPersona(browser, "alice@example.com", "Alice Rivera");
  await aliceNew.page.goto(`${BASE}/profile`);
  await aliceNew.page.waitForSelector('[data-testid="new-device-card"]', { timeout: 45_000 });
  await aliceNew.page.click("summary:has-text('None of these work?')");
  await aliceNew.page.click('[data-testid="start-over"]');
  await aliceNew.page.click('[data-testid="start-over-confirm-confirm"]');
  // Start-over wipes the fleet and drops straight into the enroll wizard.
  await aliceNew.page.check('[data-testid="consent-checkbox"]', { timeout: 45_000 });
  await aliceNew.page.click('[data-testid="consent-next"]');
  await aliceNew.page.waitForSelector('[data-testid="signature-pad"]');
  await drawSignature(aliceNew.page);
  await aliceNew.page.click('[data-testid="finish-enroll"]');
  const rekeyLink = aliceNew.page.locator('a[href*="/vouch?c="]');
  await expect(rekeyLink).toBeVisible({ timeout: 60_000 });
  const rekeyUrl = (await rekeyLink.getAttribute("href"))!;

  // Bob's vouch screen flags the re-key (roster-derived, A7).
  await bob.page.goto(rekeyUrl);
  await expect(bob.page.locator('[data-testid="rekey-notice"]')).toBeVisible({ timeout: 45_000 });
  await bob.page.check('[data-testid="vouch-confirm"]');
  await bob.page.click('[data-testid="vouch-submit"]');
  await bob.page.waitForSelector('[data-testid="vouch-done"]', { timeout: 30_000 });

  // One approver vouch: attested again, old key superseded at that instant.
  await aliceNew.page.goto(`${BASE}/profile`);
  await expect(aliceNew.page.getByText("Ready to sign")).toBeVisible({ timeout: 60_000 });
  await expect(aliceNew.page.locator('[data-testid="devices-panel"]')).toBeVisible({
    timeout: 30_000,
  });

  // Repudiation-proofing: her paid claim, signed by the superseded key,
  // still verifies — and so does the public link.
  await aliceNew.page.goto(`${BASE}/claims/${claimId}`);
  await aliceNew.page.getByTestId("audit-details").first().getByText("Audit details").click();
  await expect(aliceNew.page.getByTestId("audit-status").first()).toContainText(
    "Everything checks out",
    { timeout: 30_000 }
  );
  const anon = await browser.newContext({ viewport: { width: 480, height: 1100 } });
  const anonPage = await anon.newPage();
  await anonPage.goto(`${BASE}/v/${publicToken}`);
  await expect(anonPage.getByText("Confirmed genuine")).toBeVisible({ timeout: 30_000 });
  await anon.close();
});

test("a mid-enroll crash strands no one: the key re-reports on the next visit", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  // The production incident: Safari killed the tab's Firestore channel
  // mid-enroll, so custody completed but the key-report POST never ran —
  // status "pending" with an empty publicKey, no vouch QR, invisible in
  // /api/esign/pending. Reproduce it by blocking exactly that POST.
  evan = await newPersona(browser, "evan@example.com", "Evan Park");

  // Root allowlists Evan on the Members page (scope is still "allowlist"
  // from the rollout test).
  await root.page.goto(`${BASE}/members`);
  await root.page.waitForSelector('[data-testid="members-directory"]', { timeout: 30_000 });
  const evanRow = root.page.locator('[data-testid="members-directory"] li', {
    hasText: "evan@example.com",
  });
  await evanRow.locator('[data-testid^="allow-"]').click();
  await expect(evanRow.locator('[data-testid^="disallow-"]')).toBeVisible({ timeout: 15_000 });

  let blocked = 0;
  await evan.page.route("**/api/esign/identity", async (route) => {
    if (
      route.request().method() === "POST" &&
      (route.request().postData() ?? "").includes("publicKey")
    ) {
      blocked++;
      return route.abort("failed");
    }
    return route.continue();
  });

  await evan.page.goto(`${BASE}/profile`);
  await evan.page.click('[data-testid="enable-signing"]', { timeout: 30_000 });
  await evan.page.check('[data-testid="consent-checkbox"]');
  await evan.page.click('[data-testid="consent-next"]');
  await evan.page.waitForSelector('[data-testid="signature-pad"]');
  await drawSignature(evan.page);
  await evan.page.click('[data-testid="finish-enroll"]');
  // The block fires only AFTER custody finished (the report is enroll's last
  // step) — once it has, the wizard has failed and the stranded row exists.
  await expect.poll(() => blocked, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(evan.page.locator('[data-testid="finish-enroll"]:not([disabled])')).toBeVisible({
    timeout: 30_000,
  });

  // Stranded: pending status, but keyless — so vouchers cannot see him.
  const before = await root.context.request.get(`${BASE}/api/esign/pending`);
  expect(
    ((await before.json()).pending as { email: string }[]).map((p) => p.email)
  ).not.toContain("evan@example.com");

  // The next plain visit self-heals: custody re-derives the key and reports
  // it, the vouch QR appears, and the voucher fallback list gains him.
  await evan.page.unroute("**/api/esign/identity");
  await evan.page.goto(`${BASE}/profile`);
  const evanLink = evan.page.locator('a[href*="/vouch?c="]');
  await expect(evanLink).toBeVisible({ timeout: 60_000 });
  const after = await root.context.request.get(`${BASE}/api/esign/pending`);
  expect(((await after.json()).pending as { email: string }[]).map((p) => p.email)).toContain(
    "evan@example.com"
  );

  // And the healed key is the one custody signs with: a real vouch lands.
  await root.page.goto((await evanLink.getAttribute("href"))!);
  await root.page.check('[data-testid="vouch-confirm"]');
  await root.page.click('[data-testid="vouch-submit"]');
  await root.page.waitForSelector('[data-testid="vouch-done"]', { timeout: 30_000 });
  await evan.page.goto(`${BASE}/profile`);
  await expect(evan.page.getByText("Ready to sign")).toBeVisible({ timeout: 60_000 });
});
