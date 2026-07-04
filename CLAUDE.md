# Numbers — agent guide

Church reimbursement app: photograph receipts ("Shoebox") → receipt-level LLM extraction
(merchant, date, printed total, refund total, item summary — ONE line item per receipt;
OpenRouter or Google AI Studio, per `AI_PROVIDER`) → human verifies every row → filled official
CFCC PDF form + receipts appended. Splitting a row is the multi-ministry mechanism; there is no
per-item extraction. Next.js 15 App Router, SQLite + Prisma, Firebase Auth (+ self-issued
session cookie), sharp, pdf-lib. Single Docker container, `/data` volume.

## Commands

```bash
npm run dev                 # dev server (needs .env; see .env.example)
npm run build               # prod build (runs type checking; use to validate changes)
npm test                    # Vitest unit suite (fast, no db)
npm run test:e2e            # Playwright; local sandbox: E2E_BROWSERS=chromium \
                            #   PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e
npx prisma migrate dev --name <n>   # after editing prisma/schema.prisma
```

First-time setup: `cp .env.example .env` (uncomment `AI_MOCK=1`, `AUTH_TEST_MODE=1`), then
`npm install && npx prisma migrate dev`.

## Hard invariants — do not break

1. **Money is integer cents** (`amountCents`, `totalCents`). Convert only via `src/lib/money.ts`.
   Dollars exist only at UI/LLM boundaries. Never do float arithmetic on money.
2. **Every API route** wraps its body in `handleApi()` and starts with `await requireUserId()`
   (`src/lib/api.ts`); every Prisma query filters by that `userId`. Cross-tenant access returns
   **404**, never 403.
3. **Human-in-the-loop gate**: PDF generation requires every non-excluded line item
   `isVerified` with a non-empty `ministry` (the AI may *suggest* a ministry via the Suggest
   feature but never assigns or verifies one — a human applies suggestions; verifying a
   ministry-less row is refused in the line-items PATCH route). Enforced in
   `src/app/api/reimbursements/[id]/pdf/route.ts` — keep it there, the UI's disabled
   button is cosmetic. Single-ministry mode (claim-level ministry mirrored onto rows by the
   claim PATCH route) is a convenience, not a lock — fan-outs un-verify the rows they touch.
4. **Content edits revoke verification**: changing description/amountCents/ministry
   sets `isVerified=false` unless the patch explicitly sets it (see line-items PATCH route).
5. **`totalCents` is recomputed server-side** after every line-item mutation. Never trust a
   client-provided total.
6. **Status machines**: Receipt `unassigned ⇄ processed` ("processed" = on ≥1 GENERATED
   claim — a receipt may join any number of claims); Reimbursement `draft ⇄ generated`.
   Generated claims are frozen (line-item routes reject with 409). The escape hatch is
   POST `/api/reimbursements/[id]/revert` (claim → draft; receipts released unless another
   generated claim holds them).
7. **Telemetry**: every AI call (success AND failure) writes an `ExtractionLog` — receipt
   extraction `kind="receipt"`, ministry suggestions `kind="suggestion"`; every manual edit
   writes an `AuditEvent` with field diffs (`update-claim` for claim-level settings; fan-out
   row updates carry `source:"claim-ministry"`); `LineItem.original*` freezes AI values
   at creation (NULL = human-created row, e.g. a split half); the printed totals behind the
   AI's net amount live in `Receipt.extractedTotalCents/extractedRefundCents`. New mutation
   paths must keep this trail complete.
8. **The PDF is an AcroForm fill** of `assets/cfcc-form-template.pdf` (13 rows/page). Field
   names are the contract — see `docs/agent/ARCHITECTURE.md` for the exact list (note the
   double space in `For Ministry  EventRow{n}`).

## Docs map

- `docs/agent/ARCHITECTURE.md` — file map, request flows, PDF field names, env vars
- `docs/agent/DATA_MODEL.md` — schema semantics, state machines, invariants per table
- `docs/agent/CONVENTIONS.md` — code patterns + gotchas that have already bitten (read before UI/test work)
- `docs/agent/TESTING.md` — how suites run, how to write tests here, known failure modes
- `docs/agent/PLAYBOOKS.md` — step-by-step recipes for common change types
- `docs/DESIGN.md` — human-oriented rationale; read when you need the "why"

## Repo etiquette

- TypeScript strict; 2-space indent; comments only for non-obvious constraints.
- `data/`, `.e2e-data/`, `screenshots/`, `tests/e2e/.fixtures/` are generated — never commit.
- After schema changes commit the generated `prisma/migrations/**` files.
- Validate with `npm run build && npm test` minimum; run e2e (chromium) for UI/API changes.
