# Playbooks — recipes for common changes

Each recipe lists every file that must move together. Finish every recipe with:
`npm run build && npm test`, then
`E2E_BROWSERS=chromium E2E_FORCE_BUILD=1 npm run test:e2e` if UI/API behavior changed.

## Add or rename a ministry / budget category

1. Edit `MINISTRY_GROUPS` in `src/lib/ministries.ts` (single source; config.ts re-exports it).
2. Nothing else — dropdown and PDF all read it. Existing rows keep their old string
   (PATCH allows arbitrary strings; the dropdown shows a legacy/custom value under "Other…").

## Add a field to LineItem (e.g. `notes`)

1. `prisma/schema.prisma` → add column → `npx prisma migrate dev --name line_item_notes`.
2. If AI-extracted: add to `src/lib/ai/schema.ts` + prompt (`src/lib/ai/prompt.ts`) + mock
   (`src/lib/ai/mock.ts`) + claim-creation mapping in `src/app/api/reimbursements/route.ts`
   (and an `originalNotes` column if humans may correct it).
3. If human-editable: add to `PatchSchema` + `contentChanged` list in
   `src/app/api/line-items/[id]/route.ts`, and to `TRACKED_FIELDS` in `src/lib/audit.ts`.
4. UI: `LineItemRow` in `src/components/ReviewClaim.tsx` (+ `data-testid`).
5. PDF: only if printed — map it in `fillFormPage` (`src/lib/pdf/generate.ts`) to an existing
   AcroForm field.
6. Tests: `audit.test.ts` tracked-fields list; journey spec if it changes review flow.

## Add a new API route

Copy the handler pattern from `docs/agent/CONVENTIONS.md`. Checklist: `runtime = "nodejs"`,
`handleApi`, `requireUserId`, userId-scoped queries, 404 for foreign resources, zod body,
AuditEvent + totalCents recompute if it mutates line items, 409 if claim not draft.
Add a security assertion (foreign-user 404) to `tests/e2e/security.spec.ts`.

## Change the extraction prompt

1. Edit `src/lib/ai/prompt.ts` only. The response contract (one JSON object
   `{merchant, purchaseDate, totalAmount, refundAmount, summary}`; the receipt id is stamped
   server-side) is enforced by `src/lib/ai/schema.ts` — change both together or neither.
   Keep the model transcribing (totals as printed), never computing or itemizing.
2. Consult telemetry first: `sqlite3 data/numbers.db "SELECT prompt, rawResponse, parsedJson
   FROM ExtractionLog WHERE status='error'"` and the `corrections` output of
   `/api/extraction-logs/:id` show what the current prompt gets wrong.
3. Unit tests in `ai-parse.test.ts` cover parsing, not prompt wording — usually no test change.

## Swap / update the church form PDF

1. Replace `assets/cfcc-form-template.pdf` (or set `TEMPLATE_PDF`). It MUST be an AcroForm.
2. Dump its field names:
   `node -e "const {PDFDocument}=require('pdf-lib');const fs=require('fs');PDFDocument.load(new Uint8Array(fs.readFileSync('assets/cfcc-form-template.pdf'))).then(d=>console.log(d.getForm().getFields().map(f=>f.getName())))"`
3. If names differ from the table in `ARCHITECTURE.md`: update `fillFormPage` in
   `src/lib/pdf/generate.ts`, the row count in `src/lib/config.ts` (`FORM_ROWS_PER_PAGE`),
   and the field-name table in `ARCHITECTURE.md`.
4. Re-run `tests/unit/pdf.test.ts`; regenerate a packet and eyeball it:
   run the journey e2e, then `node scripts/render-pdf.mjs screenshots/claim-packet.pdf /tmp/p`.

## Add an e2e scenario

1. New spec in `tests/e2e/` (desktop projects pick it up automatically; name it
   `*mobile.spec.ts`-style only if it belongs to the mobile projects — see `testMatch` /
   `testIgnore` in `playwright.config.ts`).
2. Sign in with a project-scoped email: `` `myuser-${testInfo.project.name}@example.com` ``.
3. Interact via `data-testid` / `data-description` / exact-text locators (see CONVENTIONS
   gotchas 5–7 before writing locators).
4. If asserting money, derive expected values from the mock table in `TESTING.md`.

## Add a page

1. `src/app/<name>/page.tsx` as a thin server component:
   `currentUserId()` → `redirect("/signin")` → render a client component from
   `src/components/`.
2. Add the link to `LINKS` in `src/components/NavBar.tsx` (it must fit the mobile nav —
   check `screenshots/09-mobile-shoebox.png` after the e2e run).
3. `export const dynamic = "force-dynamic"` if it reads per-user data.

## Debug a failing PDF

1. Reproduce in a unit test in `tests/unit/pdf.test.ts` (fastest loop).
2. Assert content with `pdfVisibleText`; assert structure with `PDFDocument.load` page counts.
3. Rasterize for eyes: `node scripts/render-pdf.mjs <pdf> /tmp/out` and view the PNGs.

## Upgrade dependencies

- Prisma major: check `prisma-client-js` generator + migrate CLI flags in
  `docker-entrypoint.sh` (`prisma migrate deploy`) and CI.
- Next major: re-check `ctx.params` Promise behavior, `output: "standalone"` copy paths in
  `Dockerfile`, and `serverExternalPackages`.
- Playwright: browser binaries must match; CI installs per-engine
  (`npx playwright install --with-deps <engine>`); never `playwright install` in the sandbox.
- Tailwind: v4 CSS-first — no `tailwind.config`; remember `@apply` cannot reference custom
  classes (see the UI section of CONVENTIONS.md).
