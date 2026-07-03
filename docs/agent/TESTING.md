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
| `ai-parse.test.ts` | fence/prose-tolerant JSON parsing, refund negatives, unknown-receipt-id guard, mock behavior |
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
  `tests/e2e/.fixtures/`; "refund" in the filename triggers the mock's negative items.
- `signInAs(page, email, name)` — dev-login form; waits for the dashboard.
- `uploadReceipts(page, paths)` — sets the hidden file input, waits for card count += n.

**Mock arithmetic the journey test depends on** (from `src/lib/ai/mock.ts`):
purchase receipt → PAPER TOWEL 27.98 + SNACK 15.49 + TABLE 49.99 + TAX 8.64 = **102.10**;
refund receipt → −27.98 − 2.59 = **−30.57**; 4 items purchase + 2 refund = 6 rows.
The test then: exclude snack (**56.04**), tax → 7.25 (**54.65**), split table 25.00/24.99,
edit paper 27.98→27.99, verify 6/6, download → 3 pages (1 form + 2 receipts), then asserts
telemetry (`corrections.amountCents {from:864,to:725}`, split `humanCreated`, exclusion event).
If you change mock values, update these expectations coherently.

**Spec inventory**:
- `journey.spec.ts` — full happy path + telemetry + a 16-item claim → 2 form pages + 4
  receipts = 6 PDF pages. Saves screenshots to `screenshots/` (gitignored).
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
