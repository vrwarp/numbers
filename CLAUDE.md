# Numbers — agent guide

Church reimbursement app: photograph receipts (the "Shoebox" — UI label: "Receipts") → receipt-level LLM extraction
(merchant, date, printed total, refund total, item summary — ONE line item per receipt;
OpenRouter or Google AI Studio, per `AI_PROVIDER`) → human verifies every row → filled official
CFCC PDF form + receipts appended. Splitting a row is the multi-ministry mechanism; there is no
per-item extraction. UI in en/zh-Hans/zh-Hant (next-intl; catalogs in `messages/`). Next.js 15
App Router, SQLite + Prisma, Firebase Auth (+ self-issued session cookie), sharp, pdf-lib.
Single Docker container, `/data` volume.

## Commands

```bash
npm run dev                 # dev server (needs .env; see .env.example)
npm run build               # prod build (runs type checking; use to validate changes)
npm test                    # Vitest unit suite (fast, no db)
npm run translate           # draft/refresh zh catalogs + translation-state (see CONVENTIONS)
npm run test:e2e            # Playwright; local sandbox: E2E_BROWSERS=chromium \
                            #   PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e
npm run esign:emulators     # Firebase auth+firestore emulators for e-sign e2e on the
                            #   REAL backend (no ESIGN_MOCK) — docs/agent/TESTING.md
npx prisma migrate dev --name <n>   # after editing prisma/schema.prisma
```

First-time setup: `cp .env.example .env` (uncomment `AI_MOCK=1`, `AUTH_TEST_MODE=1`), then
`npm install && npx prisma migrate dev`.

## Hard invariants — do not break

1. **Money is integer cents** (`amountCents`, `totalCents`). Convert only via `src/lib/money.ts`.
   Dollars exist only at UI/LLM boundaries. Never do float arithmetic on money.
2. **Every API route** wraps its body in `handleApi()` and starts with `await requireUserId()`
   (`src/lib/api.ts`); every Prisma query filters by that `userId`. Cross-tenant access returns
   **404**, never 403. Named exceptions: `GET /c/[token]` — the QR capability link on
   generated PDFs, where the unguessable `publicToken` is the credential (still 404 on any
   miss) — and `GET /firebase-messaging-sw.js`, the push service worker, which browsers
   re-validate after session expiry and which serves only static handler code
   (docs/NOTIFICATIONS_DESIGN.md §7.0).
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
6. **Status machines**: Receipt `unassigned ⇄ processed` ("processed" = on ≥1 claim in a
   FROZEN status — a receipt may join any number of claims); Reimbursement
   `draft ⇄ generated → submitted → approved → paid` (+ `rejected`, back toward draft/
   resubmit). FROZEN = generated|submitted|rejected|approved|paid: all frozen claims reject
   line-item mutations with 409. The escape hatch is POST `/api/reimbursements/[id]/revert`
   (any frozen-but-unpaid claim → draft, voiding collected signatures by hash mismatch;
   receipts released unless another FROZEN claim holds them). Paid is terminal.
7. **Telemetry**: every AI call (success AND failure) writes an `ExtractionLog` — receipt
   extraction `kind="receipt"`, ministry suggestions `kind="suggestion"`; every manual edit
   writes an `AuditEvent` with field diffs (`update-claim` for claim-level settings; fan-out
   row updates carry `source:"claim-ministry"`); `LineItem.original*` freezes AI values
   at creation (NULL = human-created row, e.g. a split half); the printed totals behind the
   AI's net amount live in `Receipt.extractedTotalCents/extractedRefundCents`. New mutation
   paths must keep this trail complete.
8. **The PDF is an AcroForm fill** of `assets/cfcc-form-template.pdf` (13 rows/page; claims
   of ≤8 rows auto-fill a taller-row legibility variant — same field names, never a
   different form-page count, see `variantRowsFor`). Field
   names are the contract — see `docs/agent/ARCHITECTURE.md` for the exact list (note the
   double space in `For Ministry  EventRow{n}`). Values Helvetica can't encode (Chinese
   descriptions/names) are drawn with the bundled CJK face (`src/lib/pdf/fonts.ts`) — never
   reintroduce blanket WinAnsi stripping.
9. **E-sign chain of custody** (`docs/ESIGN_DESIGN.md` is the implementation contract):
   once a claim leaves `generated` its packet bytes are archived per-hash under
   `signed/…/<sha256>.pdf` and never regenerated, overwritten, or deleted (claim deletion
   included; `EsignClaimArchive` keeps the ledger pointer/key) — `POST …/pdf` 409s while
   under signature. Mirror rows (`SignerIdentity`, `User.role`, claim status,
   `SignatureRecord`) are written ONLY from signature-verified ledger events
   (`src/lib/esign/server.ts`); ceremony UIs and `/v/<token>` re-verify the whole chain
   client-side and fail closed; the numbers server never holds Firestore credentials.
   Signed payloads are self-binding (`ledger`/`claimId`/`packetSha256`/`seq`/`closesRef`/
   `submitRef`/`approveRef`, money in integer cents); the roster + thread rules live in the
   isomorphic modules `src/lib/esign/roster.ts` + `validity.ts` — change them only with
   tests, and keep `scripts/verify-bundle.mjs` (a deliberately independent
   reimplementation) in agreement. Multi-device is charproof's AMK keystore (typed-code
   device approval, phrase/passkey recovery, revocation; `docs/MULTI_DEVICE_PLAN.md`) —
   devices are transport, the vouched KEY is the identity, so device changes never touch
   the roster. Dev/tests: `ESIGN_MOCK=1` + `ESIGN_ROOT_EMAIL` run the full protocol
   (real ECDSA, real hash binding, real charproof custody) on SQLite ledger +
   device-sync stores, no Firebase.
10. **Every user-visible string comes from `messages/<locale>.json`** (en source of truth,
   zh-Hans + zh-Hant) via next-intl; API errors carry machine-readable `code`s translated
   client-side. New/changed English ⇒ give each key a translator `context` note (required
   for short/ambiguous strings) then `npm run translate` (staleness is a red `npm test`).
   Rules and workflow: `docs/agent/CONVENTIONS.md` "Localization". The official form itself
   stays English; user data and ministry canonical values are never translated.

11. **Semantic search is a secondary index with a privacy boundary**
   (`docs/SEARCH_DESIGN.md` is the contract): embeddings/queue rows must never
   gate or fail a mutation (enqueues are fire-and-forget); every route that
   changes embedded content (receipt file/note/merchant, claim content/status
   year key) calls the matching `src/lib/embeddings/queue.ts` helper — a new
   mutation route joining invariant 7's telemetry duty joins this one; scope
   filtering is a PRE-filter re-applied at hydration; `kind="embedding"`
   ExtractionLogs store hashes/labels, never query text or composites (90-day
   retention), and the admin settings GET never returns the API key. The
   role-read grant (verified approver-or-above — approver/secretary/chairman/
   treasurer/admin — may READ all receipts +
   claims incl. drafts and never-claimed receipts) is a deliberate §6.3-style
   exception beside invariant 2 — writes stay owner-only. The grant is narrowed
   per-duty by the A10 pauses (`src/lib/roles.ts` `searchCapabilities`): a
   fully-paused role-holder reads like a member (scope/file 404); never from
   `ADMIN_EMAILS`. The TEAM read grant (§6.3 team amendment) sits beside it:
   membership in an active Team (budget-category codes) grants `scope="team"` —
   read-only over receipts whose own line item carries a team code on a
   non-draft claim (+ the containing claims) — membership-derived per request
   (`src/lib/teams-catalog.ts`), never role- or `ADMIN_EMAILS`-derived; A10
   pauses don't apply; same pre-filter + hydration re-check discipline.

12. **Push notifications are an acceleration layer, never load-bearing**
   (`docs/NOTIFICATIONS_DESIGN.md` is the contract): enqueues are fire-and-forget and can
   never gate or fail a mutation (the invariant-11 discipline); `NotificationJob` rows are
   written UNCONDITIONALLY of preferences (they feed the in-app activity list — parity for
   push-less users) and preferences are consulted only at send time; every route that lands
   a submit/decision/paid transition enqueues — `reconcile` included; push payloads carry
   titles/labels/routes, never amounts, reviewer notes, or `claimDescription`; tokens are
   never returned by any GET; the sending service account stays messaging-only
   (`cloudmessaging.messages.create` — the §12 health card checks); seen/tapped state is
   never recorded. Every user-visible push string lives in `messages/*.json` under
   `Notifications.*` and is composed at send/render time, never stored.

## Docs map

- `docs/agent/ARCHITECTURE.md` — file map, request flows, PDF field names, env vars
- `docs/ESIGN_DESIGN.md` — e-signature & approval workflow: trust model, ledger threads,
  ceremonies, attack/defense matrix (ratified design, now implemented)
- `docs/SEARCH_DESIGN.md` — semantic search: embedding ingest queue/worker, exact-match
  pass, permission matrix, admin runtime config (ratified design, now implemented)
- `docs/NOTIFICATIONS_DESIGN.md` — push notifications: catalog, outbox worker, preference
  model, iOS onboarding, trust amendments (ratified v6, implemented; setup:
  `docs/PUSH_SETUP.md`)
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
