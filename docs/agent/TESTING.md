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
| `image.test.ts` | ~100 KB compression of a synthetic noisy photo, no-upscale, garbage rejection |
| `pdf.test.ts` | page counts (13/page, receipts appended, pdf-merge), field values actually drawn (via `pdfVisibleText`), flatten removes fields, splitAddress |
| `audit.test.ts` | field-diff computation |
| `extract-meta.test.ts` | extraction metadata for telemetry; ExtractionError carries meta |

Reusable helper: `pdfVisibleText(bytes)` in `pdf.test.ts` — inflates flate streams and decodes
hex strings so you can assert on rendered PDF text. pdf tests load the real template from
`assets/` in `beforeAll`.

## E2E suite (`tests/e2e/`, Playwright)

**Harness**: `playwright.config.ts` boots `tests/e2e/start-server.sh` once per run → wipes
`.e2e-data/`, `prisma generate`, builds if needed (`E2E_FORCE_BUILD=1` forces), `prisma db push`,
`next start -p 3100` with `AI_MOCK=1 AUTH_TEST_MODE=1`. `workers: 1` (shared SQLite).
`reuseExistingServer` when not CI.

**Projects** (matrix): `chromium-desktop`, `webkit-desktop` run `journey.spec.ts` +
`security.spec.ts`; `chromium-mobile` (Pixel 7), `webkit-mobile` (iPhone 14) run
`mobile.spec.ts` only. Engines filtered by `E2E_BROWSERS`.

**Isolation rule**: all projects share one server+db per run, so every test signs in as
`` `name-${testInfo.project.name}@example.com` `` — keep doing this in new tests.

**Helpers** (`tests/e2e/helpers.ts`):
- `makeReceiptFixture(name, {refund?})` — renders a realistic receipt JPEG (sharp+SVG) into
  `tests/e2e/.fixtures/`; the MOCK keys on the FILENAME ("refund" → partial-refund fixture,
  "return" → pure return), not the image content.
- `signInAs(page, email, name)` — dev-login form; waits for the dashboard.
- `uploadReceipts(page, paths)` — sets the hidden file input, waits for card count += n.

**Mock arithmetic the journey test depends on** (from `src/lib/ai/mock.ts`, ONE row per
receipt): `costco.jpg` → Costco Wholesale 06/21, net **102.10**; `*refund*.jpg` → Amazon
06/04, charged 36.31 − refunded 5.36 = net **30.95** (derivation note shown);
`*return*.jpg` → net **−27.98** (REFUND badge). Initial claim total **105.07**.
The test then: exclude the return (**133.05**), trim Costco to 90.00 (**120.95**), split the
Amazon row 15.00/15.95, verify 3/3, edit-revokes-verify round-trip, download → 3 pages
(1 form + 2 receipts — the fully-excluded return receipt is left out of the packet), then
asserts telemetry (`corrections.amountCents {from:10210,to:9000}`, split `humanCreated`,
exclusion event). If you change mock values, update these expectations coherently.

**Spec inventory**:
- `journey.spec.ts` — full happy path + telemetry + a 14-receipt claim → 2 form pages + 14
  receipts = 16 PDF pages. Saves screenshots to `screenshots/` (gitignored).
- `security.spec.ts` — 401s when signed out; full cross-tenant 404 sweep (receipts, claims,
  files, PDFs, extraction logs, claim-from-foreign-receipt); delete/discard housekeeping;
  API-level PDF verification gate.
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

## Visual verification

`node scripts/render-pdf.mjs screenshots/claim-packet.pdf screenshots/packet` → `packet-pN.png`.
Journey screenshots land in `screenshots/01…08`. When touching the review UI or PDF layout,
regenerate and actually look at them (or have the agent Read the PNGs).

## CI

`.github/workflows/ci.yml`: `unit` job + `e2e` matrix job per engine
(`npx playwright install --with-deps <engine>`, `E2E_BROWSERS=<engine>`, `E2E_FORCE_BUILD=1`);
Playwright report artifact on failure. Docker dry-run/push lives in `docker.yml`.
