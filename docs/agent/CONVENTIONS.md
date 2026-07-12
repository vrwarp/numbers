# Conventions & gotchas

Patterns to follow and mistakes already made once so you don't make them twice.

## Route handler pattern (copy this shape)

```ts
export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();          // 401 if unauthenticated
    const { id } = await ctx.params;               // Next 15: params IS A PROMISE — await it
    const parsed = Schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "…", "someCode");
    const row = await prisma.thing.findFirst({ where: { id, userId } }); // ALWAYS scope by userId
    if (!row) throw new ApiError(404, "…", "thingNotFound"); // 404, not 403, for cross-tenant
    // … mutate; recompute totalCents if line items changed; emit AuditEvent …
    return NextResponse.json({ … });
  });
}
```

- Errors: `throw new ApiError(status, message, code?, params?)`; handleApi converts to
  `{error, code?, params?}` JSON. `message` stays English (logs/curl/fallback); `code` is the
  machine-readable identity clients translate via `Errors.<code>` in the catalogs — every
  user-surfaceable error gets one, with a matching entry in all three `messages/*.json`.
- zod for every request body; `.partial()` objects for PATCH.
- Server pages: `const userId = await currentUserId(); if (!userId) redirect("/signin");`
  There is NO middleware — every page/route checks itself.

## Money

- Store/compute in integer cents. Parse user/LLM dollars with `parseDollarsToCents` (throws on
  garbage — catch and revert the input field in UI). Display with `formatCents`
  (`-$27.98`) or `centsToDollarString` (`-27.98`, used on the PDF).
- Splits must conserve: `|first| + |second| == |total|`, both halves non-zero, sign preserved.

## Client/server module split

- `src/lib/config.ts` imports `node:path` → **server only**. Client components import
  `MINISTRIES` from `src/lib/ministries.ts`. If you add config a client component needs, put it
  in a dependency-free module like ministries.ts, re-export from config.ts.
- `sharp` and `@prisma/client` are in `serverExternalPackages` (next.config.ts) — don't import
  them anywhere client-reachable.

## Localization (en / zh-Hans / zh-Hant)

- **Every user-visible string comes from `messages/<locale>.json`** via next-intl —
  `useTranslations` in client components, `getTranslations`/`getFormatter` in server ones.
  That includes placeholders, tooltips, `title`/`aria-label`s, `confirm()` prompts, and
  client-side error fallbacks. Keys are typed against `messages/en.json` (global.d.ts) —
  a typo'd key fails `npm run build`; a missing/drifted translation fails `npm test`
  (tests/unit/messages.test.ts: key parity, ICU-argument parity, source staleness).
- Authoring rules: whole sentences per key (never assemble from fragments — inline
  links/bold via `t.rich` with `<link>`/`<strong>` chunks); ICU plurals instead of
  `${n > 1 ? "s" : ""}`; named arguments; each ternary branch is its own key; enum → label
  through `Common.status.*`; never translate data (user text, merchant names, ministry
  canonical values, "Numbers", "CFCC").
- Adding/rewording English: update `en.json` in the same PR, then `npm run translate`
  (drafts the Chinese, updates `messages/translation-state.json`) — or
  `npm run translate -- --todo` without an AI key. Reviewed keys are never overwritten
  without `--force`. Terminology lives in `messages/GLOSSARY.md`.
- Wording shared across the UI is DECLARED, not remembered: `SAME_VALUE_GROUPS` and
  `QUOTED_IN` in `src/lib/translation-state.ts`. Same-value members are auto-copied from
  their canonical key (translate the canonical); a message that quotes another element
  drafts after it with the live translation injected as `mustContain`; both invariants are
  test-enforced in every locale, so drafting order can never silently diverge them.
- Locale resolution: `numbers_locale` cookie → Accept-Language → en
  (src/i18n/request.ts); `User.locale` is the durable copy, reconciled at sign-in
  (src/i18n/cookie.ts). No URL locale routing, no middleware.
- API errors are translated CLIENT-side (`useApiErrorMessage()` — src/lib/use-api-error.ts);
  the server stays locale-free. New error string ⇒ new code ⇒ new `Errors.*` entry ×3.
  Codes are typed (`ApiErrorCode = keyof en.Errors`) — a code without a catalog entry
  fails the build. Give ambiguous short strings a translator hint via the `context`
  field in `messages/translation-state.json` (fed into drafting prompts).
- Server-side errors that never surface (config/programming errors) stay plain English —
  don't invent codes for them.
- Money display stays `$12.34` in every locale (shared with the PDF); dates go through
  next-intl formatters, never bare `toLocaleDateString()`.
- e2e runs pinned to en (playwright.config.ts `locale: "en-US"`); `i18n.spec.ts` is the one
  spec that exercises the Chinese catalogs. Keep preferring `data-testid` over text selectors.

## UI conventions

- Tailwind v4 (CSS-first, no tailwind.config). Shared classes `.btn-primary`, `.btn-secondary`,
  `.input`, `.card` in `src/app/globals.css`.
  ⚠ **Tailwind v4 cannot `@apply` a custom class** (e.g. `@apply btn`) — expand utilities per
  class or use comma-grouped selectors like globals.css does.
- Every interactive element tests touch gets `data-testid`:
  `upload-button, file-input, generate-claim, generate-pdf, discard-claim, claim-status,
  claim-total, verify-progress, row-<id>, verify-<id>, desc-<id>, ministry-<id>,
  ministry-other-<id>, event-<id>, amount-<id>, split-<id>, merge-<id>, exclude-<id>,
  subtotal-<receiptId>, group-<receiptId>,
  derivation-<receiptId>, remove-receipt-<receiptId>, revert-claim, upload-note,
  upload-note-confirm, upload-note-cancel, receipt-note-<receiptId>,
  claim-link-<receiptId>-<claimId>, split-first-amount, split-confirm, profile-name,
  profile-address, profile-save, dev-email, dev-name, dev-signin,
  edit-image-<receiptId>, edit-image-pending-<n>, image-editor-stage, crop-box,
  rotate-left, rotate-right,
  crop-reset, image-editor-save, image-editor-cancel, add-receipts, add-receipts-dialog,
  add-receipts-file-input, add-receipts-upload, add-receipts-status, add-receipts-confirm,
  add-receipts-cancel, claim-ministry-panel, claim-mode-single, claim-mode-multi,
  claim-ministry, claim-ministry-other, claim-event, claim-description, suggest-ministry,
  suggestion-banner, suggestion-apply, suggestion-dismiss, row-ministry-badge-<id>,
  mode-switch-dialog, mode-switch-confirm, mode-switch-cancel, split-mode-dialog,
  split-mode-switch, split-mode-cancel, fanout-toast, fanout-undo`.
- The claim-level ministry select is labeled "Claim ministry" ON PURPOSE — e2e loops over
  `getByLabel("Ministry", { exact: true })` to reach the per-row selects (multi mode only)
  and must not catch the claim-level one.
- Picking IMAGES does NOT upload immediately: a prepare dialog steps through each picked file
  first (local preview + `upload-note` + Save/Skip/Skip-all, testids `upload-note-confirm` /
  `upload-note-cancel` / `upload-note-skip-all` / `upload-preview`), and dismissing it is
  what uploads that file (note rides along in the POST). Image files get the
  `edit-image-pending-<n>` rotate/crop button, reusing ReceiptImageEditor in local mode
  (`onApply`, no receiptId): the transform renders on-device from the full-resolution
  original (`src/lib/image-client.ts`) and the upload is downscaled to the server's 1600px
  cap — the original photo never leaves the device. PDFs are the deliberate exception:
  browsers can't thumbnail a local PDF, so they upload the moment they're picked and their
  dialog shows the server raster (PdfReceiptPreview) and only collects the note (saved via
  PATCH). Tests must go through `uploadReceipts()` in `tests/e2e/helpers.ts`, which drains
  the queue (optional note on the first file) and then waits for the cards.
- Review rows also carry `data-description={item.description}` — e2e matches rows by it
  because descriptions live in `<textarea>`/`<input>` values, which Playwright `hasText`
  CANNOT see. Composed descriptions are long, so match with the substring attribute selector
  `[data-description*="Amazon 06/04"]`.
- Editable inputs are uncontrolled with `key={field+value}` to re-sync after server responses;
  commit on blur; revert on parse failure.
- Accessible names matter to tests: the confirm button's visible label flips between
  `"✓ Confirm $<amount>"` and `"✓ Verified · Undo"` (e2e matches `/Confirm \$/`, which also
  drops verified rows out of the locator); exclude button's `title` flips between
  `"Exclude item (personal / not reimbursable)"` and `"Restore item"`. Renaming these breaks
  the e2e suite.

## Gotchas that already bit (verbatim knowledge)

1. **Next 15**: `ctx.params` in route handlers and `params` in pages are **Promises** — await.
2. **AcroForm names**: `For Ministry  EventRow{n}` has a double space; the address-2 field is
   misspelled `Make check to address 2` in the real PDF. Copy names exactly.
3. **assets/cfcc-form-template.pdf is the real church form** — never regenerate, re-save, or
   "optimize" it; pdf tooling can strip the AcroForm.
4. **Prisma client must be generated** before build/tests on a fresh checkout
   (`npx prisma generate`; `tests/e2e/start-server.sh` does it).
5. **Playwright + input values**: `locator.filter({hasText})` does not match `<input value>` —
   use the `data-description` attribute selector.
6. **Playwright strict mode**: prefer `getByText("…", { exact: true })` — substring matches hit
   filenames like `costco-refund.jpg` and prose ("generated claims are ready…").
7. **Clicking all approve buttons**: the accessible name changes after each click, so
   `.all()`+`nth(i)` goes stale — click `.first()` in a counted loop and assert progress text.
8. **E2E users must be unique per Playwright project** (`grace-${testInfo.project.name}@…`) —
   desktop chromium and webkit share one server+db per run. Tests that count receipts/rows
   also suffix `-r${testInfo.retry}` so a CI retry doesn't inherit the first attempt's data.
9. **PDF text assertions**: pdf-lib flate-compresses streams and hex-encodes drawn text. Use
   the `pdfVisibleText` helper in `tests/unit/pdf.test.ts` (regex `stream\r?\n` scan +
   `inflateSync` + `<hex>` decode). Raw `bytes.includes("text")` will silently fail.
10. **Local sandbox browsers**: don't run `playwright install`; set
    `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium` and `E2E_BROWSERS=chromium`.
11. **`next start` warns** about `output: "standalone"` — harmless in the e2e harness; Docker
    uses `node server.js` from the standalone bundle.
12. **Buffer typing**: sharp returns `Buffer<ArrayBufferLike>`; annotate `let data: Buffer`
    when reassigning from `Buffer.from(await file.arrayBuffer())` or tsc complains.

## Telemetry duty (when adding mutations)

Any new route that changes line items must: (a) reject non-draft claims (409), (b) write an
AuditEvent with a meaningful `action`/`detail`, (c) recompute `totalCents` if amounts/exclusion
changed, (d) preserve `original*` columns untouched.
