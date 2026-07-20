# Testing reference

## Commands

```bash
npm test                                   # Vitest unit suite (~5s, no db/network)
npx vitest run tests/unit/pdf.test.ts      # single file
npm run test:e2e                           # Playwright, all engines (chromium+webkit)
E2E_BROWSERS=chromium npm run test:e2e     # chromium projects only
E2E_FORCE_BUILD=1 …                        # force `next build` even if .next exists —
                                           # REQUIRED after changing app code, or the e2e
                                           # server serves a stale build
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium …   # sandbox/pre-installed browser
npx playwright test tests/e2e/journey.spec.ts --project=chromium-desktop   # one spec
```

## Unit suite (`tests/unit/`, Vitest, node env, alias `@ → src`)

| File | Covers |
| :-- | :-- |
| `money.test.ts` | parse/format round-trips, refunds, garbage rejection, subtotals |
| `paginate.test.ts` | 13-row page splits, order preservation, `[] → [[]]` |
| `ai-parse.test.ts` | fence/prose-tolerant JSON object parsing, refund default/negative rejection, date format, unknown-receipt-id guard, mock fixtures, composeDescription |
| `image.test.ts` | ~100 KB compression of a synthetic noisy photo, no-upscale, garbage rejection; transformReceiptImage rotation/crop (crop is post-rotation), min-size rejection |
| `pdf.test.ts` | page counts (13/page, receipts appended, pdf-merge), field values actually drawn (via `pdfVisibleText`), flatten removes fields, splitAddress |
| `audit.test.ts` | field-diff computation |
| `extract-meta.test.ts` | extraction metadata for telemetry; ExtractionError carries meta |
| `claims-rows.test.ts` | annotation→row and outcome→row builders: original* freezing (AI) vs NULL (manual), refund math, placeholder rows, fresh-vs-consumed round-trip |
| `annotation-retry.test.ts` | background-worker retry plan (quota never burns attempts, exponential backoff, terminal at 5) + the ≤1/minute pace window math |
| `ministries.test.ts` | budget-list integrity, isKnownMinistry, formatMinistryEvent, mostCommonMinistryEvent (mode-switch adoption) |
| `suggest.test.ts` | suggestion prompt (chart of accounts + church context), response parsing (unknown ministry → null), account-number fallback matching, mockSuggest keyword rules (e2e depends on them), mock-mode metadata |

Reusable helper: `pdfVisibleText(bytes)` in `pdf.test.ts` — inflates flate streams and decodes
hex strings so you can assert on rendered PDF text. pdf tests load the real template from
`assets/` in `beforeAll`. ⚠ CJK-bearing values are CID-encoded through the subset font, so
their glyph hex is NOT the text (the whole field, embedded Latin included) — assert via the
ToUnicode CMap instead (`<gid> <unicodeHex>` pairs; see "generateClaimPdf with Chinese
content"), or rasterize with `scripts/render-pdf.mjs` / `scripts/verify-cjk-pdf.mjs` and look.

## E2E suite (`tests/e2e/`, Playwright)

**Harness**: `playwright.config.ts` boots `tests/e2e/start-server.sh` once per run → wipes
`.e2e-data/`, `prisma generate`, builds if needed (`E2E_FORCE_BUILD=1` forces), `prisma db push`,
`next start -p 3100` with `AI_MOCK=1 AUTH_TEST_MODE=1`. `workers: 1` (shared SQLite).
`reuseExistingServer` when not CI. The background annotation worker is kept DORMANT
(`EXTRACTION_PACE_MS=900000`; the pace gates the first call too), so every spec runs on
deterministic claim-time inline extraction — a live drip would stamp merchants on other
specs' receipts at unpredictable moments and shift merchant-chip counts and search exact
matches. `background-annotation.spec.ts` is the one spec that exercises the worker: it
flips the pace to 0 through the `.e2e-data/config.json` hot-reload and restores it in
`afterEach`. Claim rows are identical either way (a consumed annotation adopts its
upload-time log; a pending receipt extracts inline with a claim-linked log).

**Projects** (matrix): `chromium-desktop`, `webkit-desktop` run every non-mobile spec
(`journey.spec.ts`, `security.spec.ts`, `image-edit.spec.ts`); `chromium-mobile` (Pixel 7),
`webkit-mobile` (iPhone 14) run `mobile.spec.ts` only. Engines filtered by `E2E_BROWSERS`.

**Isolation rule**: all projects share one server+db per run, so every test signs in as
`` `name-${testInfo.project.name}@example.com` `` — keep doing this in new tests.

**Helpers** (`tests/e2e/helpers.ts`):
- `makeReceiptFixture(name, {refund?})` — renders a realistic receipt JPEG (sharp+SVG) into
  `tests/e2e/.fixtures/`; the MOCK keys on the FILENAME ("refund" → partial-refund fixture,
  "return" → pure return), not the image content.
- `signInAs(page, email, name)` — dev-login form; waits for the dashboard.
- `uploadReceipts(page, paths, note?)` — sets the hidden file input, drains the per-file
  prepare dialog (each Save/Skip is what actually uploads that file; optional note goes on
  the first), then waits for card count += n.

**Mock arithmetic the journey test depends on** (from `src/lib/ai/mock.ts`, ONE row per
receipt): `costco.jpg` → Costco Wholesale 06/21, net **102.10**; `*refund*.jpg` → Amazon
06/04, charged 36.31 − refunded 5.36 = net **30.95** (derivation note shown);
`*return*.jpg` → net **−27.98** (REFUND badge). Initial claim total **105.07**.
The journey switches the claim to **Multiple** mode right after landing on the review screen
(new claims default to single-ministry mode, which hides the per-row ministry selects); the
14-receipt test stays in single mode and fans one claim-level pick onto all rows.
The test then: exclude the return (**133.05**), trim Costco to 90.00 (**120.95**), split the
Amazon row 15.00/15.95, verify 3/3, edit-revokes-verify round-trip, download → 3 pages
(1 form + 2 receipts — the fully-excluded return receipt is left out of the packet), then
asserts telemetry (`corrections.amountCents {from:10210,to:9000}`, split `humanCreated`,
exclusion event). If you change mock values, update these expectations coherently.

**Spec inventory**:
- `journey.spec.ts` — full happy path + telemetry + a 14-receipt claim → 2 form pages + 14
  receipts = 16 PDF pages. Saves screenshots to `screenshots/` (gitignored).
- `security.spec.ts` — 401s when signed out; full cross-tenant 404 sweep (receipts, claims,
  files, PDFs, extraction logs, image edits, claim-from-foreign-receipt, add-to-foreign-claim);
  delete/discard housekeeping; API-level PDF verification gate.
- `add-receipts.spec.ts` — add receipts to a draft from the review screen (Shoebox pick +
  in-dialog upload), totals/rows/audit-trail assertions, 409 duplicate-add and
  409-once-generated guards, button hidden on generated claims.
- `image-edit.spec.ts` — rotate via the review-screen dialog (stored dims swap), crop via the
  API (fractions → pixels), audit trail, 409 freeze once generated, 400 for PDF receipts.
- `single-ministry.spec.ts` — single-ministry mode (the default for new claims): Suggest →
  pending banner → apply fans out to all rows (+ suggestion ExtractionLog, persisted
  claimDescription, PDF gate passes); multi→single adopt-most-common dialog + undo toast
  restores rows/verification; Split-in-single-mode gate ("Switch & split"); cross-tenant 404s
  for the claim PATCH and suggest routes. Mock suggestions key on DESCRIPTION KEYWORDS
  ("youth"+"retreat" → 471, "retreat" → 470, "office" → 237, else null — src/lib/ai/suggest.ts).
- `background-annotation.spec.ts` — the background worker reads an upload (card chip flips to
  "✓ merchant · amount"), claim creation consumes the stored annotation with NO fresh AI call
  (the upload-time log is adopted by the claim; a second claim reuses the annotation and gets
  no logs).
- `mobile.spec.ts` — phone capture flow + manifest check.

## Failure modes seen before (check these first)

- E2E fails only on 2nd desktop project → a test uses a non-project-scoped email.
- `toHaveCount` resolves to more elements than expected → substring text match; use
  `{ exact: true }` or data-testid.
- Row locator times out → tried `hasText` against input values; use `data-description`.
- PDF text assertion fails though the PDF looks right → used raw byte search instead of
  `pdfVisibleText`.
- e2e green locally but app changes absent → forgot `E2E_FORCE_BUILD=1` (stale `.next`).
- `Executable doesn't exist …chrome-headless-shell` → set `PLAYWRIGHT_CHROMIUM_PATH` (do not
  `playwright install` in the sandbox).

## E-sign e2e against the Firebase emulator (the real backend, no mock)

`ESIGN_MOCK` is a reimplementation and reimplementations drift — the emulator
suite runs the REAL Firestore ledger store, charproof custody, and the
production `firestore.rules` with no live project (LetUsMeet's pattern).
Requires Java (Firestore emulator) and the `firebase-tools` dev dependency.

```bash
npm run esign:emulators          # auth :9099 + firestore :8080, rules loaded
# then run the server WITHOUT ESIGN_MOCK, pointing at the emulators:
FIREBASE_PROJECT_ID=demo-numbers \
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
AUTH_TEST_MODE=1 AI_MOCK=1 ESIGN_ROOT_EMAIL=<root email> npm run dev
npm run esign:rules-canary       # with the same env: backdated write must be DENIED
```

How it works: when the emulator host pair is set, the registry relays an
`emulator` block inside `firebaseConfig`; the browser connects both SDK
emulators (forced long polling — do NOT add the 5s poll cycle, it starves
`runTransaction`), swaps the Google popup for silent email/password sign-in
as the session's email, and injects the mock passkey (headless can't do
WebAuthn). Same email ⇒ same emulator uid ⇒ a member's browser contexts share
one account doc, like production. Restart the emulators for a clean slate —
state is in-memory.

The COMMITTED suite for this backend is `tests/esign-e2e/esign.spec.ts`
(own config `playwright.esign.config.ts`, own server script, port 3101,
strictly serial — one multi-context story from bootstrap through key
supersession, including a server-side REST assert that AMK rotation actually
committed). Entry points, LetUsMeet's Docker pattern:

```bash
npm run test:e2e:esign          # inner command — run it under emulators:exec
npm run test:e2e:esign:local    # emulators:exec wrapper (needs Java locally)
npm run test:e2e:esign:docker   # Dockerfile.e2e: playwright image + Java; what CI runs
```

CI runs the docker variant as the `esign-e2e` job in
`.github/workflows/ci.yml` (emulator jars cached; HTML report uploaded on
failure). `Dockerfile.e2e`'s base image pin must match `@playwright/test` in
package.json — bump them together.

Real bugs the emulator caught that the mock could not (keep it in the loop):
fractional `toMillis()` breaking the mirror's BigInt, a Firebase-init
single-flight race that sent a concurrent caller to production endpoints, the
uid-keyed mirror sync clobbering in-flight re-enrollments, and Firestore's
key-sorted maps breaking join-order assumptions.

## Visual verification

`node scripts/render-pdf.mjs screenshots/claim-packet.pdf screenshots/packet` → `packet-pN.png`.
Journey screenshots land in `screenshots/01…08`. When touching the review UI or PDF layout,
regenerate and actually look at them (or have the agent Read the PNGs).

## CI

`.github/workflows/ci.yml`: `unit` job + `e2e` matrix job per engine
(`npx playwright install --with-deps <engine>`, `E2E_BROWSERS=<engine>`, `E2E_FORCE_BUILD=1`);
Playwright report artifact on failure. Docker dry-run/push lives in `docker.yml`.


## Recorded real embeddings (search e2e)

The e2e server does NOT hit the embedding endpoint: `tests/e2e/start-server.sh`
boots `tests/e2e/mock-embedding-server.mjs`, which replays REAL vectors recorded
from the production endpoint into `tests/e2e/embedding-fixtures/embeddings.json`
(committed). Search journeys therefore assert genuine model geometry — bilingual
receipts, zh↔en cross-language ranking, and exact recorded cosine scores
(`search-journeys.spec.ts`; the score-fidelity test doubles as a canary for the
image pipeline's byte determinism, since a sha miss degrades to projection and
shifts the scores).

- **Resolution**: recorded image (sha of the app-normalized JPEG) or recorded
  text → verbatim vector; anything else (dynamic claim composites, ad-hoc spec
  queries) → token-overlap projection onto the recorded anchors + a hash-bag
  component, so arbitrary texts still rank by wording. `__EMBED_FAIL__` → 500
  (degraded-mode lever).
- **Re-record against a new model/endpoint** (regenerates vectors + the
  expected-score matrix; `--render` also re-rasterizes the receipt images with
  Chromium — reliable CJK):

  ```bash
  EMBEDDING_ENDPOINT=https://… EMBEDDING_API_KEY=sk-… npm run record:embeddings -- --render
  ```

  The manifest of receipts/queries/anchors lives in
  `tests/e2e/embedding-fixtures/manifest.ts`; model + dim flow from the
  recording into the e2e env automatically, so a model swap is: re-record,
  re-run, commit the json/pngs.
