# Architecture reference

Single Next.js 15 (App Router) process = UI + API + auth. SQLite via Prisma. Files on local
disk under `DATA_DIR`. No queue, no cache, no other services. External calls: one AI provider
(OpenRouter or Google AI Studio, per `AI_PROVIDER`), at claim creation only (one call per receipt).

## File map (what lives where)

```
src/auth.ts                     session cookie → currentUserId()/currentUser(). Identity comes
                                from Firebase Auth (Google sign-in in the browser); the session
                                itself is ours (src/lib/session.ts)
src/lib/session.ts              HMAC-signed stateless session token (AUTH_SECRET, 30d) +
                                cookie set/clear helpers — SERVER ONLY
src/lib/firebase-admin.ts       firebaseWebConfig() (relayed to the sign-in page),
                                verifyFirebaseIdToken() via firebase-admin (projectId only,
                                no service-account key)
src/lib/api.ts                  ApiError, requireUserId(), handleApi() — wrap EVERY route body
src/lib/config.ts               server config: dataDir()/uploadsDir() (imports node:path —
                                SERVER ONLY), FORM_ROWS_PER_PAGE=13, IMAGE_TARGET_BYTES,
                                isAiMock(), isAuthTestMode(); re-exports MINISTRIES
src/lib/ministries.ts           MINISTRIES list — dependency-free, safe for client components
src/lib/money.ts                parseDollarsToCents, centsToDollarString, formatCents,
                                subtotalCents — the ONLY money conversion code
src/lib/storage.ts              saveReceiptFile/readStoredFile/deleteStoredFile; blocks path
                                traversal outside DATA_DIR
src/lib/image.ts                compressReceiptImage: rotate() → ≤1600px → jpeg q80→40 ladder
                                → 1100px fallback; target ~100 KB. isSupportedUpload()
src/lib/audit.ts                computeLineItemChanges(before, patch) → {field:{from,to}}
src/lib/ai/prompt.ts            buildExtractionPrompt() — THE prompt being tuned (one receipt
                                per call; extraction only, ministries are a human choice)
src/lib/ai/schema.ts            zod ModelItemSchema {description, quantity, amount(dollars)};
                                ExtractedItem = model item + server-stamped receiptId
src/lib/ai/parse.ts             parseExtractionResponse(text, receiptId): strips fences/prose,
                                zod-validates, stamps receiptId (model output ids are ignored)
src/lib/ai/mock.ts              deterministic extraction for AI_MOCK=1; "refund" in filename →
                                all-negative items. E2E math depends on these exact numbers
src/lib/ai/extract.ts           extractReceipt(receipt) → {items, meta} (throws ExtractionError
                                carrying meta); extractReceipts(receipts) → per-receipt outcomes
                                (never rejects), one provider HTTP call each, concurrency 3
src/lib/ai/providers.ts         AI_PROVIDER dispatch (openrouter | google) + the two HTTP
                                callers; failures throw ProviderCallError carrying the raw body
src/lib/pdf/paginate.ts         paginateItems(items, 13) → pages; [] → [[]]
src/lib/pdf/generate.ts         generateClaimPdf(input): per form page load template → fill
                                AcroForm fields → flatten → copyPages into output; then append
                                receipts (images on Letter pages w/ label, PDFs merged).
                                Also splitAddress()
src/lib/pdf/loadTemplate.ts     TEMPLATE_PDF env override, else assets/cfcc-form-template.pdf
src/components/NavBar.tsx       top nav (client); hidden when signed out
src/components/Shoebox.tsx      upload input, receipt grid, selection bar, generate-claim POST
src/components/ReviewClaim.tsx  the review screen (largest component): groups, LineItemRow,
                                SplitDialog, optimistic PATCH, PDF download
src/components/ProfileForm.tsx  name + mailing address form
src/app/layout.tsx              shell; reads session; renders NavBar
src/app/page.tsx                dashboard (server component, direct Prisma)
src/app/signin/page.tsx         server shell for SignInCard (passes firebase config + test flag)
src/components/SignInCard.tsx   client: Firebase Google popup → POST idToken to
                                /api/auth/session; dev-login form → /api/auth/test-login
src/app/shoebox|claims|profile  thin server components: currentUserId() → redirect("/signin")
                                → render client component
assets/cfcc-form-template.pdf   the real church AcroForm — DO NOT regenerate or optimize
prisma/schema.prisma            data model (see DATA_MODEL.md)
tests/unit/*.test.ts            Vitest; tests/e2e/*.spec.ts Playwright (see TESTING.md)
scripts/render-pdf.mjs          rasterize a PDF to PNGs (pdfjs-dist) for visual checks
Dockerfile / docker-entrypoint.sh  standalone build; entrypoint runs prisma migrate deploy
.github/workflows/ci.yml        unit + e2e matrix (chromium, webkit jobs)
.github/workflows/docker.yml    PR: dry-run build; main: push to Docker Hub
```

## API routes (all: handleApi + requireUserId; JSON errors `{error}`)

| Route | Methods | Behavior |
| :-- | :-- | :-- |
| `/api/auth/session` | POST | `{idToken}` → verifyFirebaseIdToken (verified email required) → upsert User by email (stores firebaseUid) → set session cookie. No requireUserId (this IS login) |
| | DELETE | clear session cookie (sign out) |
| `/api/auth/test-login` | POST | `{email,name}` → upsert + cookie; 404 unless AUTH_TEST_MODE=1 |
| `/api/receipts` | GET | list own receipts; `?status=` filter |
| | POST | multipart field `files`; images → compressReceiptImage, pdf → as-is; creates Receipt(unassigned); 415 unsupported, 400 empty |
| `/api/receipts/[id]` | DELETE | only if not in any claim (409 otherwise); removes file |
| `/api/receipts/[id]/file` | GET | serve stored bytes, owner only |
| `/api/reimbursements` | GET | list own claims with counts |
| | POST | `{receiptIds[]}` → validates ownership + all `unassigned` (409 else) → extractReceipts (one call per receipt) → any failure: log ALL calls + 502, no claim; else create draft + line items (with original* snapshot) + one ExtractionLog per call |
| `/api/reimbursements/[id]` | GET | claim + lineItems(sortOrder asc) + receipts join |
| | DELETE | draft only (409 else); receipts return to shoebox |
| `/api/reimbursements/[id]/pdf` | POST | gate: ≥1 active row, all active verified (400 else) → generateClaimPdf → claim=generated, receipts=processed → returns application/pdf. Re-POST on generated claim re-downloads |
| `/api/line-items/[id]` | PATCH | zod partial {description,quantity,amountCents,ministry,isVerified,isExcluded}; draft only (409); isVerified:true refused (400) while ministry is empty; content change ⇒ isVerified=false unless patch sets it; writes AuditEvent(update) when changes non-empty; recomputes totalCents; returns {lineItem, totalCents} |
| `/api/line-items/[id]/split` | POST | `{firstAmountCents?}` default even split; both halves unverified; new row original*=NULL; AuditEvent(split); renumbers sortOrder so new half follows original |
| `/api/profile` | GET PATCH | fullName, mailingAddress (printed on the form) |
| `/api/extraction-logs` | GET | own logs, `?reimbursementId=`, newest first, summaries |
| `/api/extraction-logs/[id]` | GET | full tuning record: log + lineItems w/ computed `corrections` + `humanCreated` + parsed auditEvents |

## Request flows (condensed)

**Upload**: FormData → isSupportedUpload → (image? compress to jpeg) → saveReceiptFile
`uploads/<userId>/<cuid>.<jpg|pdf>` → prisma.receipt.create.

**Claim creation**: receiptIds → ownership/status checks → `extractReceipts` (mock if
AI_MOCK=1; else one provider call PER receipt — OpenRouter chat/completions with the image/PDF
inline as data-URI, or Google AI Studio generateContent with inline_data;
receipt id stamped server-side) → parse+validate → create Reimbursement + LineItems
(ministry starts empty — the user must pick one per row during review; amount dollars→cents;
original*=extracted values) → ExtractionLog.

**PDF**: gate check → read receipt files → `generateClaimPdf({requesterName, requesterAddress,
dateString(MM/DD/YYYY), items(active only), receipts, templateBytes})` → transaction: claim
generated + receipts processed → stream bytes.

## PDF AcroForm field names (the contract with assets/cfcc-form-template.pdf)

Per row n = 1..13 (⚠ literal double space in the ministry field name):

- `Description QuantityRow{n}` — description
- `Description QuantityRow{n}_2` — quantity
- `AmountRow{n}` — amount (plain `centsToDollarString`, e.g. `-27.98`)
- `For Ministry  EventRow{n}` — ministry

Header/footer fields: `Make check payable to`, `Mail check to address`,
`Make check to address 2` (sic — that's the real name), `TotalAmount` (grand total on last
page, `(continued)` earlier), `For Ministry  EventTotal` (used for `Page x of y` when
multi-page), `Requestor Name`, `Request Date`. Left blank on purpose: `Approver Name`,
`Approval Date`, treasurer fields. Missing fields warn and skip (template swap tolerance);
`form.updateFieldAppearances(helv)` then `form.flatten()` bakes values in.

## Environment variables

| Var | Notes |
| :-- | :-- |
| `DATABASE_URL` | `file:./data/numbers.db` dev; `file:/data/numbers.db` in image |
| `DATA_DIR` | upload root; `./data` dev, `/data` in image |
| `AUTH_SECRET` | signs the session cookie — required |
| `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID` (+optional `FIREBASE_APP_ID`) | Firebase web config; Google button rendered only if all three present. Client-safe values, relayed at runtime (not NEXT_PUBLIC_*, so one Docker image works everywhere) |
| `AI_PROVIDER` (`openrouter` default, or `google`) | which extraction backend to call |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (default `google/gemini-3.1-flash-lite`) | extraction via OpenRouter |
| `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-3.1-flash-lite`) | extraction via Google AI Studio (Gemini API) |
| `AI_MOCK=1` | deterministic extraction, no network (tests/dev) |
| `AUTH_TEST_MODE=1` | enables dev login (tests/dev only) |
| `TEMPLATE_PDF` | optional replacement blank form path |
| `E2E_BROWSERS`, `E2E_FORCE_BUILD`, `PLAYWRIGHT_CHROMIUM_PATH` | test harness (see TESTING.md) |
