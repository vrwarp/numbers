# Architecture reference

Single Next.js 15 (App Router) process = UI + API + auth. SQLite via Prisma. Files on local
disk under `DATA_DIR`. No queue, no cache, no other services. External calls: GLM API only,
once per claim creation.

## File map (what lives where)

```
src/auth.ts                     NextAuth v5 config; JWT sessions; Google + test-mode Credentials
                                provider; jwt callback upserts domain User, pins token.userId;
                                exports auth(), currentUserId()
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
src/lib/ai/prompt.ts            buildExtractionPrompt(receiptIds) — THE prompt being tuned
src/lib/ai/schema.ts            zod ExtractedItemSchema {receiptId, description, quantity,
                                amount(dollars), suggestedMinistry}
src/lib/ai/parse.ts             parseExtractionResponse(text, validIds): strips fences/prose,
                                zod-validates, rejects unknown receipt ids
src/lib/ai/mock.ts              deterministic extraction for AI_MOCK=1; "refund" in filename →
                                all-negative items. E2E math depends on these exact numbers
src/lib/ai/extract.ts           extractLineItems(receipts) → {items, meta}; throws
                                ExtractionError carrying meta for failure logging; GLM HTTP call
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
src/app/signin/page.tsx         Google button + dev-login form (server actions calling signIn)
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
| `/api/auth/[...nextauth]` | GET POST | NextAuth handlers |
| `/api/receipts` | GET | list own receipts; `?status=` filter |
| | POST | multipart field `files`; images → compressReceiptImage, pdf → as-is; creates Receipt(unassigned); 415 unsupported, 400 empty |
| `/api/receipts/[id]` | DELETE | only if not in any claim (409 otherwise); removes file |
| `/api/receipts/[id]/file` | GET | serve stored bytes, owner only |
| `/api/reimbursements` | GET | list own claims with counts |
| | POST | `{receiptIds[]}` → validates ownership + all `unassigned` (409 else) → extractLineItems → create draft + line items (with original* snapshot) + ExtractionLog(success). ExtractionError → ExtractionLog(error) + 502 |
| `/api/reimbursements/[id]` | GET | claim + lineItems(sortOrder asc) + receipts join |
| | DELETE | draft only (409 else); receipts return to shoebox |
| `/api/reimbursements/[id]/pdf` | POST | gate: ≥1 active row, all active verified (400 else) → generateClaimPdf → claim=generated, receipts=processed → returns application/pdf. Re-POST on generated claim re-downloads |
| `/api/line-items/[id]` | PATCH | zod partial {description,quantity,amountCents,ministry,isVerified,isExcluded}; draft only (409); content change ⇒ isVerified=false unless patch sets it; writes AuditEvent(update) when changes non-empty; recomputes totalCents; returns {lineItem, totalCents} |
| `/api/line-items/[id]/split` | POST | `{firstAmountCents?}` default even split; both halves unverified; new row original*=NULL; AuditEvent(split); renumbers sortOrder so new half follows original |
| `/api/profile` | GET PATCH | fullName, mailingAddress (printed on the form) |
| `/api/extraction-logs` | GET | own logs, `?reimbursementId=`, newest first, summaries |
| `/api/extraction-logs/[id]` | GET | full tuning record: log + lineItems w/ computed `corrections` + `humanCreated` + parsed auditEvents |

## Request flows (condensed)

**Upload**: FormData → isSupportedUpload → (image? compress to jpeg) → saveReceiptFile
`uploads/<userId>/<cuid>.<jpg|pdf>` → prisma.receipt.create.

**Claim creation**: receiptIds → ownership/status checks → `extractLineItems` (mock if
AI_MOCK=1; else one GLM chat/completions call, receipts inline as data-URIs each preceded by
`RECEIPT ID: <id>` text part) → parse+validate → create Reimbursement + LineItems
(ministry must be in MINISTRIES else "General Fund"; amount dollars→cents; original*=extracted
values) → ExtractionLog.

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
| `AUTH_SECRET`, `AUTH_URL`, `AUTH_TRUST_HOST` | NextAuth |
| `GOOGLE_CLIENT_ID/SECRET` | Google provider registered only if both present |
| `GLM_API_KEY`, `GLM_BASE_URL` (default Z.ai), `GLM_MODEL` (default `glm-5.2`) | extraction |
| `AI_MOCK=1` | deterministic extraction, no network (tests/dev) |
| `AUTH_TEST_MODE=1` | enables dev login (tests/dev only) |
| `TEMPLATE_PDF` | optional replacement blank form path |
| `E2E_BROWSERS`, `E2E_FORCE_BUILD`, `PLAYWRIGHT_CHROMIUM_PATH` | test harness (see TESTING.md) |
