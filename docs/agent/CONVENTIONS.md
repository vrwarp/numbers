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
    if (!parsed.success) throw new ApiError(400, "…");
    const row = await prisma.thing.findFirst({ where: { id, userId } }); // ALWAYS scope by userId
    if (!row) throw new ApiError(404, "…");        // 404, not 403, for cross-tenant
    // … mutate; recompute totalCents if line items changed; emit AuditEvent …
    return NextResponse.json({ … });
  });
}
```

- Errors: `throw new ApiError(status, message)`; handleApi converts to `{error}` JSON.
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

## UI conventions

- Tailwind v4 (CSS-first, no tailwind.config). Shared classes `.btn-primary`, `.btn-secondary`,
  `.input`, `.card` in `src/app/globals.css`.
  ⚠ **Tailwind v4 cannot `@apply` a custom class** (e.g. `@apply btn`) — expand utilities per
  class or use comma-grouped selectors like globals.css does.
- Every interactive element tests touch gets `data-testid`:
  `upload-button, file-input, generate-claim, generate-pdf, discard-claim, claim-status,
  claim-total, verify-progress, row-<id>, verify-<id>, desc-<id>, ministry-<id>,
  ministry-other-<id>, event-<id>, amount-<id>, split-<id>, exclude-<id>,
  subtotal-<receiptId>, group-<receiptId>,
  derivation-<receiptId>, remove-receipt-<receiptId>, revert-claim, upload-note,
  upload-note-confirm, upload-note-cancel, receipt-note-<receiptId>,
  claim-link-<receiptId>-<claimId>, split-first-amount, split-confirm, profile-name,
  profile-address, profile-save, dev-email, dev-name, dev-signin,
  edit-image-<receiptId>, image-editor-stage, crop-box, rotate-left, rotate-right,
  crop-reset, image-editor-save, image-editor-cancel`.
- Uploading is immediate, but a describe dialog then steps through each uploaded receipt
  (preview + `upload-note` + Save/Skip/Skip-all, testids `upload-note-confirm` /
  `upload-note-cancel` / `upload-note-skip-all` / `upload-preview`). Tests must go through
  `uploadReceipts()` in `tests/e2e/helpers.ts`, which dismisses the queue and takes an
  optional note (applied to the first receipt).
- Review rows also carry `data-description={item.description}` — e2e matches rows by it
  because descriptions live in `<textarea>`/`<input>` values, which Playwright `hasText`
  CANNOT see. Composed descriptions are long, so match with the substring attribute selector
  `[data-description*="Amazon 06/04"]`.
- Editable inputs are uncontrolled with `key={field+value}` to re-sync after server responses;
  commit on blur; revert on parse failure.
- Accessible names matter to tests: the approve button's aria-label flips between
  `"Approve row"` and `"Mark unverified"`; exclude button's `title` flips between
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
   desktop chromium and webkit share one server+db per run.
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
