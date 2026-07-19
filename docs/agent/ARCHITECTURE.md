# Architecture reference

Single Next.js 15 (App Router) process = UI + API + auth. SQLite via Prisma. Files on local
disk under `DATA_DIR`. No queue, no cache, no other services. External calls: one AI provider
(OpenRouter or Google AI Studio, per `AI_PROVIDER`), only when a claim is built — creation or
adding receipts to a draft (one call per receipt) — or when the user clicks "Suggest" on the
review screen (one text-only ministry/event suggestion call).

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
src/lib/config-file.ts          configValue(name): env setting resolved from
                                <DATA_DIR>/config.json (JSON of NAME→value) first, else
                                process.env (SERVER ONLY, fs). All server env reads go through
                                this so a deployment is reconfigurable via a data-volume file;
                                DATA_DIR itself is exempt (it locates the file)
src/lib/ministries.ts           MINISTRY_GROUPS budget categories (+ flat MINISTRIES,
                                isKnownMinistry, formatMinistryEvent, mostCommonMinistryEvent)
                                — dependency-free, safe for client components
src/lib/positions.ts            Positions (custom approval roles): approverEligibility +
                                pickSuggestedApprover (the default-approver pre-fill selection) +
                                DEFAULT_POSITION_ENTRIES (the standing deacon roster the editor's
                                empty-state "Load default positions" button seeds — never
                                auto-applied) — dependency-free, unit-tested, client-safe
src/lib/positions-catalog.ts    Position table reads + resolveSuggestedApprover(claim) (SERVER);
src/lib/positions-guard.ts      requirePositionEditor (treasurer/admin, same gate as ministries)
src/lib/teams-catalog.ts        Teams reads + the TEAM READ GRANT (SEARCH_DESIGN §6.3 team
                                amendment): teamPrefetch (allowed-id Sets for scope="team"),
                                canReadReceiptViaTeam (file/preview per-id check),
                                hasTeamReadGrant (canTeam) — membership-derived, SERVER ONLY
src/lib/teams-guard.ts          canManageTeams/requireTeamEditor (Approver-or-above or
                                app-admin — wider than ministries on purpose; narrowed by
                                the A10 duty pauses like the role-read grant: needs ≥1
                                active duty. Pauses never touch the membership READ grant)
src/components/Teams.tsx        /teams editor: name/description, member picker, budget-category
                                code chips (stored as codes, not Ministry ids)
src/lib/members-guard.ts        canViewMembers/requireMemberDirectoryViewer (treasurer/admin
                                + the other executive officers, A11) — the /members page +
                                /api/members directory
src/components/MembersDirectory.tsx  the Members page: full directory (roles, Positions,
                                e-sign status), RoleControls for executive officers/admin
                                (role grant; key revocation stays root-only, moved off the
                                vouch screen), admin-only allowlist grant/cancel; links
                                Vouch/Positions/Budget Categories
src/lib/locales.ts              LOCALES en/zh-Hans/zh-Hant, labels, numbers_locale cookie
                                name, Accept-Language negotiator — dependency-free, client-safe
src/lib/role-label.ts           roleLabelKey(): role string → Common.role.* message key,
                                shared by every role-tag renderer — dependency-free, client-safe
src/i18n/request.ts             next-intl request config: cookie → Accept-Language → en
                                (no URL locale routing, no middleware)
src/i18n/cookie.ts              setLocaleCookie + syncLocalePreference (sign-in reconciles
                                device cookie vs User.locale) — SERVER ONLY
src/lib/use-api-error.ts        useApiErrorMessage(): client hook translating {error, code,
                                params} bodies (and NDJSON error lines) via Errors.* catalog
src/lib/translation-state.ts    flatten/unflatten/messageArguments + StateEntry — shared by the
                                parity test and scripts/translate-messages.ts
src/components/LocaleSwitcher.tsx  language picker (compact NavBar chip, small sign-in
                                select, prominent segmented control on the empty Receipts
                                screen): writes the cookie, PATCHes profile when signed in,
                                router.refresh()
messages/*.json                 the string catalogs (en = source of truth) + GLOSSARY.md +
                                translation-state.json (per-key English source/status/context)
scripts/translate-messages.ts   npm run translate — drafting/staleness/state pipeline
src/lib/church-context.ts       loadChurchContext(): operator-authored church vocabulary doc
                                (CHURCH_CONTEXT_PATH, default <DATA_DIR>/church-context.md;
                                null when absent; 16 KB cap) fed into suggestion prompts —
                                SERVER ONLY. Template: docs/church-context.example.md
src/lib/money.ts                parseDollarsToCents, centsToDollarString, formatCents,
                                subtotalCents — the ONLY money conversion code
src/lib/storage.ts              saveReceiptFile/readStoredFile/deleteStoredFile; blocks path
                                traversal outside DATA_DIR
src/lib/image.ts                compressReceiptImage: rotate() → ≤1600px → WebP q10→5→1
                                (effort 4) ladder → 1100px fallback; target ~100 KB; output is
                                image/webp. isSupportedUpload(). transformReceiptImage:
                                autoOrient → 90° rotation + fractional crop (post-rotation
                                frame) → same ladder; ImageTransformError → 400
src/lib/audit.ts                computeLineItemChanges(before, patch) → {field:{from,to}}
src/lib/claims.ts               shared claim-building machinery (SERVER ONLY): extractClaimRows
                                (per-receipt extraction → line-item/receipt-update row data; a
                                read failure degrades to a blank manual-entry row, quota errors
                                stay all-or-nothing 429), manualClaimRows (all-blank rows, no AI
                                — the manual escape hatch), extractionLogRow, claimProgressStream
                                (NDJSON progress response), apiErrorJson
src/lib/claim-stream.ts         ClaimStreamMessage — the NDJSON progress-line union shared by
                                the claim-building routes and their client consumers
                                (dependency-free, client-safe)
src/lib/ndjson.ts               readNdjsonStream(body, onLine) — client-side NDJSON reader
src/lib/ai/prompt.ts            buildExtractionPrompt() — THE prompt being tuned (one receipt
                                per call; TRANSCRIPTION only: merchant/date/printed totals/
                                summary — no itemizing, no computed totals, no ministries)
src/lib/ai/schema.ts            zod ModelReceiptSchema {merchant, purchaseDate("YYYY-MM-DD"|
                                null), totalAmount, refundAmount(≥0, default 0), summary}
                                (dollars); ExtractedReceipt = result + server-stamped receiptId
src/lib/ai/parse.ts             parseExtractionResponse(text, receiptId): strips fences/prose,
                                zod-validates the object, stamps receiptId (model ids ignored)
src/lib/ai/compose.ts           composeDescription(result) → "Amazon 06/04 — rulers, duct
                                tape…" (the initial editable line-item description)
src/lib/ai/mock.ts              deterministic extraction for AI_MOCK=1; "refund" in filename →
                                partial-refund fixture (net 30.95), "return" → pure return
                                (net −27.98). E2E math depends on these exact numbers
src/lib/ai/extract.ts           extractReceipt(receipt) → {result, meta} (throws ExtractionError
                                carrying meta); extractReceipts(receipts) → per-receipt outcomes
                                (never rejects), one provider HTTP call each, concurrency 3
src/lib/ai/providers.ts         AI_PROVIDER dispatch (openrouter | google) + the two HTTP
                                callers (doc optional — omitted for text-only calls); failures
                                throw ProviderCallError carrying the raw body
src/lib/ai/suggest.ts           suggestMinistryEvent(description): text-only "which ministry/
                                event is this claim for?" call — prompt embeds the chart of
                                accounts (each category with its optional treasurer-authored
                                description) + church context; answer validated against MINISTRIES
                                (unknown → null, never invented); mockSuggest keyword rules for
                                AI_MOCK=1. A SUGGESTION only — applying it is the human's click
src/lib/pdf/paginate.ts         paginateItems(items, 13) → pages; [] → [[]]
src/lib/pdf/generate.ts         generateClaimPdf(input): per form page load template → fill
                                AcroForm fields → flatten → optional QR self-link stamp →
                                copyPages into output; then append receipts (images on Letter
                                pages w/ label, PDFs merged). Also splitAddress()
src/lib/pdf/qr.ts               qrMatrix(url) + applyQrStamp(page, url, font): narrows the
                                "Note:" box (white-out + redraw with re-flowed text) and draws
                                a vector QR of the /c/<publicToken> capability URL in the
                                freed slot beside it (geometry in NOTE_BOX / QR_STAMP)
src/lib/pdf/loadTemplate.ts     TEMPLATE_PDF env override, else assets/cfcc-form-template.pdf
src/lib/pdf/fonts.ts            embedCjkFont(doc): bundled pan-CJK Noto face
                                (assets/fonts/NotoSansCJKtc-Regular.otf, CJK_FONT_PATH
                                override) embedded as a subset via upstream fontkit 2.x
                                (adapter bridges pdf-lib's encodeStream expectation —
                                @pdf-lib/fontkit drops glyphs on CJK-scale fonts). Used by
                                generate.ts for any field/label value Helvetica can't encode
src/lib/image-client.ts         DOM-only canvas helpers for the pre-upload prepare step:
                                renderTransformedImage (rotate/crop at native resolution,
                                crop fractions on the ROTATED frame — same contract as
                                transformReceiptImage) and prepareImageUpload (downscale to
                                the 1600px cap; undecodable files fall through untouched)
src/components/NavBar.tsx       top nav (client); hidden when signed out
src/components/Shoebox.tsx      upload input, selection bar, generate-claim POST;
                                per-card expand button opens ReceiptViewer. Picked images
                                queue through a PREPARE dialog (local preview + optional
                                note + client-side rotate/crop on the full-res original);
                                Save/Skip uploads the downscaled result — the original
                                photo never leaves the device (beforeunload warns while
                                un-uploaded images are queued). Picked PDFs upload
                                IMMEDIATELY instead (no local thumbnail possible) and
                                their dialog shows the server raster + note-only
src/components/ReceiptGrid.tsx  the selectable receipt-card grid (Shoebox + AddReceiptsDialog);
                                exports ReceiptSummary (the GET /api/receipts row shape)
src/components/AddReceiptsDialog.tsx  review-screen modal: pick Shoebox receipts / upload new
                                ones → POST /api/reimbursements/[id]/receipts (streamed)
src/components/ReceiptViewer.tsx  full-screen viewer (client): image zoom/pan (wheel, pinch,
                                drag, buttons); PDFs show their per-page raster previews in a
                                natively scrollable column with button zoom (↗ still opens the
                                real PDF); launches ReceiptImageEditor for unassigned photos,
                                cache-busts on save
src/components/ReviewClaim.tsx  the review screen (largest component): groups, LineItemRow,
                                SplitDialog, optimistic PATCH, PDF download
src/components/ReceiptImageEditor.tsx  rotate/crop dialog (image receipts): CSS-rotated
                                preview + draggable crop box. Stored-receipt mode (draft-claim
                                review, Shoebox viewer) POSTs /api/receipts/[id]/edit; Reset
                                clears the unsaved rotate/crop and, when an earlier edit
                                exists, STAGES a restore that previews the read-only original
                                (file?original=1) — nothing is written until Save (POST
                                {restore:true}), Cancel discards it; parent cache-busts the
                                <img> after. Local mode (Shoebox prepare step: onApply, no
                                receiptId) hands the transform back for an on-device canvas
                                render instead — no restore UI
src/components/ProfileForm.tsx  name + mailing address form
src/app/layout.tsx              shell; reads session; renders NavBar
src/app/page.tsx                home = the Shoebox (server component: auth check + profile
                                nudge via direct Prisma, then renders Shoebox)
src/app/shoebox/page.tsx        legacy path — unconditional redirect("/")
src/app/signin/page.tsx         server shell for SignInCard (passes firebase config + test flag)
src/components/SignInCard.tsx   client: Firebase Google popup → POST idToken to
                                /api/auth/session; dev-login form → /api/auth/test-login
src/app/claims|profile          thin server components: currentUserId() → redirect("/signin")
                                → render client component
assets/cfcc-form-template.pdf   the real church AcroForm — DO NOT regenerate or optimize
assets/cfcc-form-template-{2,4,8}row.pdf
                                large-row legibility variants: same table area, form
                                fields and names, but 2/4/8 taller rows (rebuild with
                                scripts/make-row-variants.mjs — never edit by hand).
                                Packet generation auto-picks the smallest variant a
                                claim fits on (loadTemplate.ts variantRowsFor; ≥9 rows
                                or a configured TEMPLATE_PDF → official form), which
                                never changes the packet's form-page count; generate.ts
                                scales row font sizes to the taller cells (14pt cap)
prisma/schema.prisma            data model (see DATA_MODEL.md)
tests/unit/*.test.ts            Vitest; tests/e2e/*.spec.ts Playwright (see TESTING.md)
src/lib/embeddings/             semantic search (docs/SEARCH_DESIGN.md): provider.ts
                                (verified endpoint contract; WebP/PDF→JPEG ≤640px),
                                mock.ts (similarity-meaningful, __EMBED_FAIL__ lever),
                                settings.ts (DB-authoritative config + env seed),
                                content.ts (composite/fingerprints), queue.ts
                                (fire-and-forget enqueues + debounce), worker.ts
                                (singleton loop, generation-conditional finalize,
                                backfill/GC sweep), index-cache.ts (delta-maintained
                                Float32 matrix), exact.ts + normalize.ts (NFKC
                                tokenized LIKE pass), search.ts (the §6 engine),
                                query-cache.ts (query-embedding LRU)
src/instrumentation.ts          starts the embedding worker (nodejs runtime only,
                                never at build, dev needs EMBEDDING_DEV/MOCK)
src/lib/use-open-param.ts       the ?open=<id> deep-link contract (see CONVENTIONS)
src/lib/roles.ts                hasRoleReadGrant() — the ratified §6.3 role-read grant
src/components/SearchClient.tsx /search screen (IME-safe submit, exact strip, best
                                match, year groups, recents, sessionStorage restore)
src/components/admin/SearchIndexTab.tsx  admin search tab (outcome language)
src/lib/pdf/preview.ts          rasterize a PDF receipt to PER-PAGE WebP images (pdfjs-dist +
                                @napi-rs/canvas + sharp) for inline mobile display; ~300 DPI,
                                each page gets its own ~100 KB WebP q10→5→1 ladder; first 10
                                pages only, omitted count reported in the manifest
src/components/PdfReceiptPreview.tsx  inline PDF preview: fetches the /preview manifest (spinner
                                "Rendering preview…" while the server rasterizes), stacks one
                                <img> per page, "+N more pages" note when truncated, "open
                                original" link + 📄 fallback; used by ReviewClaim and the Shoebox
                                dialog (exports usePdfPreviewManifest, reused by ReceiptViewer).
                                ReceiptGrid shows /preview?page=1 (top slice) as its card thumb
scripts/render-pdf.mjs          rasterize a PDF to PNGs (pdfjs-dist) for visual checks
Dockerfile / docker-entrypoint.sh  standalone build; entrypoint runs prisma migrate deploy
.github/workflows/ci.yml        unit + e2e matrix (chromium, webkit jobs)
.github/workflows/docker.yml    PR: dry-run build; main: push to Docker Hub
```

## API routes (all: handleApi + requireUserId; JSON errors `{error, code?, params?}` — code is the client-translation key)

| Route | Methods | Behavior |
| :-- | :-- | :-- |
| `/api/auth/session` | POST | `{idToken}` → verifyFirebaseIdToken (verified email required) → upsert User by email (stores firebaseUid) → set session cookie. No requireUserId (this IS login) |
| | DELETE | clear session cookie (sign out) |
| `/api/auth/test-login` | POST | `{email,name}` → upsert + cookie; 404 unless AUTH_TEST_MODE=1 |
| `/api/receipts` | GET | list own receipts (+ `claims: {id,status,createdAt}[]` each receipt is on); `?status=` filter |
| | POST | multipart field `files` (+ optional `note` text stored on every receipt in the batch — the Shoebox prepare step uploads one file per POST with its note); images → compressReceiptImage (the Shoebox client already downscaled to the 1600px cap; the route still enforces its own budget), pdf → as-is; creates Receipt(unassigned); 415 unsupported, 400 empty |
| `/api/receipts/[id]` | PATCH | `{note}` (≤300 chars) — user metadata, editable in any state, no AuditEvent (not part of the claim trail) |
| | DELETE | only if not in any claim (409 otherwise); removes file + preserved original + any cached PDF preview |
| `/api/receipts/[id]/file` | GET | serve stored bytes, owner only; `?original=1` serves the preserved pristine upload (sidecar), falling back to the current file |
| `/api/receipts/[id]/preview` | GET | PDF receipts only: raster preview (mobile browsers won't render an embedded PDF). No query → JSON manifest `{pages, omitted}`; `?page=N` → that page as WebP. All pages rendered+cached beside the original on first request (`<id>.preview.json` + `<id>.preview-pN.webp`) via `src/lib/pdf/preview.ts`. 400 for non-PDF receipts or an out-of-range page |
| `/api/receipts/[id]/edit` | GET | `→ {hasOriginal}` — whether a pristine upload is preserved to restore |
| | POST | `{rotate: 0|90|180|270, crop?: {left,top,width,height} fractions of the ROTATED frame, restore?, reimbursementId?}` → sharp rotate→crop → compression ladder → overwrite stored file + sizeBytes. Source is the current file, or the preserved original when `restore:true` (rotate/crop still apply on top). A normal first edit copies the pristine upload to `<id>.orig.<ext>` (`originalFilePath`); `{restore:true}` with no transform is a plain restore. AuditEvent(edit-receipt-image / restore-receipt-image). 400 PDFs/no-op/too-small crop/nothing-to-restore; 409 while receipt is `processed` (a generated claim's packet must re-download unchanged) |
| `/api/reimbursements` | GET | list own claims with counts |
| | POST | `{receiptIds[], manual?}` → validates ownership (404 else; ANY status is allowed — a receipt may go on many claims and is re-extracted each time) → extractReceipts (one call per receipt) → create draft + ONE line item per receipt (composed description, amount = total − refunds, original* snapshot) + stamp Receipt merchant/purchaseDate/extracted*Cents + one ExtractionLog per call. A read failure degrades to a BLANK manual-entry row (no receiptUpdate, original* NULL) instead of failing the batch; only a quota/rate-limit error is all-or-nothing (log ALL + 429, no claim). `manual:true` skips AI entirely → all-blank rows, no ExtractionLogs (the rate-limit escape hatch) |
| `/api/reimbursements/[id]` | GET | claim + lineItems(sortOrder asc) + receipts join + `approverInfo` (A9/A10 availability) + `suggestedApproverUserId`/`suggestedApproverPosition` (Positions pre-fill: pre-submit statuses only, fail-open — the largest-dollar category's default Position → its first approval-eligible non-owner holder; never assigns) |
| | PATCH | zod partial {singleMinistry, claimMinistry, claimEvent, claimDescription}; draft only (409). When single mode is on and the mirrored values were touched (or the mode was just enabled), FANS claimMinistry/claimEvent out onto every non-excluded row — each touched row is un-verified and gets its own AuditEvent(update, source:"claim-ministry") — plus one AuditEvent(update-claim) for the settings diff. Multi→single with no explicit claimMinistry adopts `mostCommonMinistryEvent(rows)`. Returns the full refreshed claim (GET shape). Single mode is a mirror, not a lock: row PATCHes stay allowed |
| | DELETE | draft only (409 else); receipts return to shoebox |
| `/api/reimbursements/[id]/suggest` | POST | `{description}` (≤300) → draft only (409); persists it as claimDescription (AuditEvent on change) → text-only provider call (mock-aware, RPM-throttled, no cooldown retry — the user is waiting) → `{suggestion: {ministry(null unless verbatim in MINISTRIES), event, rationale}}`; ExtractionLog(kind:"suggestion") success AND failure; 429 quota / 502 unusable answer. Never writes to line items — the human applies via the claim PATCH |
| `/api/reimbursements/[id]/pdf` | POST | gate: ≥1 active row, all active verified (400 else) → mint `publicToken` if absent (24 random bytes base64url; stable thereafter) → generateClaimPdf (packet appends only receipts with ≥1 non-excluded row; QR self-link stamp on each form page when `PUBLIC_BASE_URL` is set) → packet saved to `generated/<userId>/<claimId>.pdf` → claim=generated (+publicToken), receipts=processed → returns application/pdf. Re-POST on generated claim regenerates + re-downloads |
| `/c/[token]` | GET | **no auth — the QR capability link.** The unguessable `publicToken` is the credential; serves the LATEST stored packet (`generated/<userId>/<claimId>.pdf`, overwritten on every generation) inline with `Cache-Control: no-store`. Unknown/malformed token or missing file → plain 404. The one deliberate exception to the requireUserId rule |
| `/__/auth/*`, `/__/firebase/*` | GET/POST | **no auth — Firebase's sign-in helper, reverse-proxied** to `<FIREBASE_PROJECT_ID>.firebaseapp.com` (rewritten onto the `/fbauth/[...path]` route). Only reached when `FIREBASE_AUTH_PROXY=1` points the client `authDomain` at this origin; makes Google sign-in first-party for iOS/WebKit. Another deliberate exception to requireUserId (it is the sign-in endpoint) |
| `/api/reimbursements/[id]/receipts` | POST | `{receiptIds[], manual?}` → add receipts to a DRAFT claim (409 generated; 409 if any receipt is already on it; 404 foreign/unknown) → same extraction pipeline as create (read failure → blank manual-entry row; quota all-or-nothing; `manual:true` skips AI; ONE line item per receipt appended after existing sortOrders, inheriting the claim's ministry/event when the claim is in single-ministry mode; Receipt extraction fields stamped) → AuditEvent(add-receipt) + ExtractionLog per call + totalCents recompute. Returns `{ok, totalCents}` or NDJSON progress per Accept header |
| `/api/reimbursements/[id]/receipts/[receiptId]` | PATCH | manual entry for a failed-extraction placeholder: `{merchant, purchaseDate, totalAmount, refundAmount, summary}` (dollars) → draft only (409); receipt must be on the claim (404) with exactly ONE un-split row (409 else) → stamps Receipt + fills the row (composed description, amount = total − refund; still unverified, original* stay NULL) → AuditEvent(manual-entry) + totalCents recompute |
| | DELETE | draft only (409); refuses the last receipt (409 — discard the claim instead); deletes the receipt's line items + join row (receipt returns to Shoebox — status never left `unassigned`); AuditEvent(remove-receipt); recomputes totalCents |
| `/api/reimbursements/[id]/revert` | POST | generated only (409 else); claim → draft; receipts → unassigned unless another GENERATED claim still holds them; AuditEvent(revert-to-draft). Rows keep isVerified (values were frozen; edits still revoke) |
| `/api/line-items/[id]` | PATCH | zod partial {description,amountCents,ministry,event,isVerified,isExcluded}; draft only (409); isVerified:true refused (400) while ministry is empty (event is always optional); content change ⇒ isVerified=false unless patch sets it; un-excluding a row on a single-ministry claim stamps the claim's ministry/event onto it (it missed any fan-outs while excluded); writes AuditEvent(update) when changes non-empty; recomputes totalCents; returns {lineItem, totalCents} |
| `/api/line-items/[id]/split` | POST | `{firstAmountCents?}` default even split; both halves unverified; new row original*=NULL; AuditEvent(split); renumbers sortOrder so new half follows original |
| `/api/line-items/[id]/merge` | POST | no body; undo-split: folds row into the same-receipt row directly above (400 if none, or if either row excluded); draft only (409); survivor keeps its description/ministry/event/original*, sums amounts, isVerified=false; merged row deleted; AuditEvent(merge); renumbers sortOrder; recomputes totalCents |
| `/api/profile` | GET PATCH | fullName, mailingAddress (printed on the form), locale, and the A10 duty pauses (`approvalsPaused`/`financePaused`/`adminPaused` — self-service; changes audited `update-availability`). Returns `{user, duties}` where `duties` says which toggles the member's grants make relevant |
| `/api/members` | GET | the Members page directory: EVERY user with mirror role, Position, e-sign enrollment status, allowlist state, key fingerprint — treasurer/admin gated (`requireMemberDirectoryViewer`, 404 otherwise). Read-only; the page's mutations go through their own guards (roster events, `PATCH /api/esign/allowlist`) |
| `/api/teams` | GET PUT | the Teams catalog (SEARCH_DESIGN §6.3 team amendment): GET teams+member directory, PUT replace (archive-don't-delete, audited `admin-teams`) — Approver-or-above via `requireTeamEditor` (404 otherwise). Associations stored as budget-category CODES |
| `/api/search` | POST | semantic + exact search (docs/SEARCH_DESIGN.md §6): scope mine/all/decided/team (mine free; all/decided role-gated by the verified mirror; team gated on live Team membership — member asking beyond their grants → 404), exact-match SQL pass + cosine over the in-memory index, degraded exact-only mode when the embed call fails, decided/team browse with cursor (decided = claims by decidedAt; team = the team receipts by createdAt). 404 while unconfigured |
| `/api/admin/embeddings` (+ `/probe`, `/jobs`, `/rebuild`, `/test-query`) | GET PUT POST | admin search backend config (probe detects dim; GET returns key fingerprint only), queue health/failed retries, forced rebuild, scored test query — behind `requireAdmin()` |
| `/api/extraction-logs` | GET | own logs, `?reimbursementId=`, newest first, summaries (kind="embedding" rows excluded — operational, §9) |
| `/api/extraction-logs/[id]` | GET | full tuning record: log + lineItems w/ computed `corrections` + `humanCreated` + parsed auditEvents |

## Request flows (condensed)

**Upload**: pick files → images wait in the Shoebox prepare dialog (client-side: optional
rotate/crop rendered from the full-res original, then downscale to ≤1600px — the original
never uploads; Save/Skip POSTs), while PDFs POST immediately so their dialog can preview the
server raster → FormData → isSupportedUpload → (image? compress to jpeg) → saveReceiptFile
`uploads/<userId>/<cuid>.<jpg|pdf>` → prisma.receipt.create.

**Claim creation**: receiptIds → ownership/status checks → `extractReceipts` (mock if
AI_MOCK=1; else one provider call PER receipt — OpenRouter chat/completions with the image/PDF
inline as data-URI, or Google AI Studio generateContent with inline_data;
receipt id stamped server-side. Calls are throttled to `AI_RPM_TARGET`/min by a shared limiter
and retried on quota errors — see `src/lib/ai/throttle.ts`) → parse+validate → create
Reimbursement + ONE LineItem per receipt (description = composeDescription(merchant/date/summary);
amountCents = totalAmount − refundAmount in cents; ministry starts empty — the user must pick one
per row during review; original*=composed/net values) + stamp
Receipt.merchant/purchaseDate/extracted*Cents in the same transaction → ExtractionLog. The review
UI shows the net-amount derivation ("charged X − refunded Y") from the Receipt columns; Split
divides a row for multi-ministry receipts. The POST returns the classic `{reimbursement}` 201 JSON,
**or** streams newline-delimited progress (per-receipt completion, quota-wait notices) when the
client sends `Accept: application/x-ndjson` — the Shoebox uses this to show live status.
Adding receipts to an existing draft (`POST /api/reimbursements/[id]/receipts`, driven by the
review screen's "＋ Add receipts" dialog) runs the same extraction pipeline via
`src/lib/claims.ts` and appends the rows, re-checking that the claim is still a draft after
the (possibly slow) extraction before writing.

**PDF**: gate check → read receipt files → mint/reuse `publicToken` →
`generateClaimPdf({requesterName, requesterAddress, dateString(MM/DD/YYYY), items(active only),
receipts, templateBytes, selfLinkUrl?})` (selfLinkUrl = `<PUBLIC_BASE_URL>/c/<token>`, omitted
when PUBLIC_BASE_URL unset → no QR stamp) → `saveGeneratedPdf` overwrites
`generated/<userId>/<claimId>.pdf` → transaction: claim generated (+publicToken) + receipts
processed → stream bytes. The QR stamp (`src/lib/pdf/qr.ts`) is drawn post-flatten on every
form page: the full-width "Note:" box is painted over and redrawn narrower (right edge
541→477pt, same four notes re-flowed in Helvetica), and a 56pt vector QR sits in the freed
slot — right-aligned to the form's content edge (x≈541), vertically centered between the
table's bottom rule (y≈292.5) and the "Requested by" bar (y≈217.5).

## PDF AcroForm field names (the contract with assets/cfcc-form-template.pdf)

Per row n = 1..13 (⚠ literal double space in the ministry field name):

- `Description QuantityRow{n}` — description
- `Description QuantityRow{n}_2` — quantity (left blank — rows are whole receipts)
- `AmountRow{n}` — amount (plain `centsToDollarString`, e.g. `-27.98`)
- `For Ministry  EventRow{n}` — `formatMinistryEvent(ministry, event)` (`"<ministry> — <event>"`, ministry alone when no event)

Header/footer fields: `Make check payable to`, `Mail check to address`,
`Make check to address 2` (sic — that's the real name), `TotalAmount` (grand total on last
page, `(continued)` earlier), `For Ministry  EventTotal` (used for `Page x of y` when
multi-page), `Requestor Name`, `Request Date`. Left blank on purpose: `Approver Name`,
`Approval Date`, treasurer fields. Missing fields warn and skip (template swap tolerance).
Each set field's appearance is generated with the font that can encode its value —
Helvetica for WinAnsi-clean values, the bundled CJK face (src/lib/pdf/fonts.ts) otherwise,
with unspaced CJK runs pre-wrapped at measured widths (pdf-lib only wraps at spaces) —
then `form.flatten()` bakes values in. Characters even the CJK face lacks (emoji) degrade
to "…" via `toEncodableText`.

The bundled template is the church's original reworked once by
`scripts/shrink-quantity-column.mjs` (quantity column narrowed to 36pt and headed "Qty",
reclaimed width given to Description). Field names and the 13-row layout are unchanged;
`generateClaimPdf` reads widget rects at runtime, so it needs no geometry constants.

## Environment variables

Every setting below (except `DATABASE_URL`, which Prisma reads directly, and
`DATA_DIR`, which locates the file itself) can also be supplied by a JSON file
at `<DATA_DIR>/config.json` — see `src/lib/config-file.ts`. The file maps the
same variable names to string values, e.g. `{"AI_PROVIDER":"google",
"GEMINI_API_KEY":"…","AI_RPM_TARGET":"10"}`. **File values win over
`process.env`**, and edits are picked up on the next read (mtime-cached, no
restart). This lets a deployment be reconfigured by editing a file on the
`/data` volume instead of relaunching the container. All server env reads go
through `configValue()`; add new ones the same way.

| Var | Notes |
| :-- | :-- |
| `DATABASE_URL` | `file:./data/numbers.db` dev; `file:/data/numbers.db` in image (read by Prisma, not overridable via config.json) |
| `DATA_DIR` | upload root; `./data` dev, `/data` in image. Bootstrap-only (locates `config.json`), so it must come from the real environment |
| `AUTH_SECRET` | signs the session cookie — required |
| `PUBLIC_BASE_URL` | externally-reachable origin (e.g. `https://numbers.example.org`); enables the QR self-link stamp on generated PDFs (`<base>/c/<publicToken>`). Unset → PDFs carry no stamp (the /c route still works if a token was ever minted) |
| `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID` (+optional `FIREBASE_APP_ID`) | Firebase web config; Google button rendered only if all three present. Client-safe values, relayed at runtime (not NEXT_PUBLIC_*, so one Docker image works everywhere) |
| `FIREBASE_AUTH_PROXY=1` | serve Firebase's `/__/auth` sign-in helper from this origin (reverse-proxied to `<FIREBASE_PROJECT_ID>.firebaseapp.com` via the `/fbauth` route + next.config rewrites) and set the client `authDomain` to `PUBLIC_BASE_URL`'s host, so the sign-in iframe/redirect is first-party — fixes iOS/WebKit storage-partitioning sign-in failures (`auth/popup-blocked`, "missing initial state"). The upstream is derived from `FIREBASE_PROJECT_ID` (not `FIREBASE_AUTH_DOMAIN`, which operators repoint at their own host → self-loop); override with `FIREBASE_AUTH_UPSTREAM_HOST`. Needs `PUBLIC_BASE_URL` + the OAuth redirect URI (`<host>/__/auth/handler`) and authorized domain registered in the console |
| `AI_PROVIDER` (`openrouter` default, or `google`) | which extraction backend to call |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (default `google/gemini-3.1-flash-lite`) | extraction via OpenRouter |
| `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-3.1-flash-lite`) | extraction via Google AI Studio (Gemini API) |
| `AI_RPM_TARGET` (default `15`) | requests/minute the server paces provider calls to (a shared rolling-window limiter in `src/lib/ai/throttle.ts`; Gemini's free tier is 15/min) |
| `AI_QUOTA_COOLDOWN_MS` (default `60000`), `AI_QUOTA_MAX_RETRIES` (default `3`) | on a quota/rate-limit error (429) wait this long and retry this many times; each wait is surfaced to the user |
| `AI_MOCK=1` | deterministic extraction + suggestions, no network (tests/dev) — bypasses throttle/retry |
| `CHURCH_CONTEXT_PATH` | operator-authored church vocabulary markdown fed into suggestion prompts; default `<DATA_DIR>/church-context.md`; feature degrades gracefully when absent. Contents are sent to the AI provider |
| `AUTH_TEST_MODE=1` | enables dev login (tests/dev only) |
| `EMBEDDING_ENDPOINT`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_DIM`, `EMBEDDING_QUERY_PREFIX`, `EMBEDDING_MIN_SCORE` | semantic search backend — SEEDS ONLY: first read creates the admin-editable `EmbeddingSettings` row, which is authoritative thereafter (docs/SEARCH_DESIGN.md §3.2) |
| `EMBEDDING_MAX_PX` (640), `EMBEDDING_TIMEOUT_MS` (120000), `EMBEDDING_DRAFT_IDLE_MS` (600000), `EMBEDDING_POLL_MS` (15000) | search ingest plumbing (image downscale cap, provider timeout, draft debounce, worker idle poll) |
| `EMBEDDING_DEV=1` | dev only: allow the env seed + worker under `next dev` (a laptop .env must not start a backfill against a production GPU) |
| `EMBEDDING_MOCK=1` | deterministic similarity-meaningful embeddings, no network (tests/dev) |
| `ADMIN_EMAILS` | comma/space-separated emails granted `/admin` access without a roster GRANT_ROLE — seeds a deployment's first admin. App-surface only (`isAppAdmin` in `src/lib/config.ts`); never writes the verified `User.role` mirror, so e-sign roster validity is untouched. Also gates the e-sign app-surface controls (master switch, rollout allowlist). Empty → admin is the roster role alone |
| `TEMPLATE_PDF` | optional replacement blank form path |
| `CJK_FONT_PATH` | optional replacement CJK font for PDF values (default `assets/fonts/NotoSansCJKtc-Regular.otf`; unreadable → warn + bundled) |
| `E2E_BROWSERS`, `E2E_FORCE_BUILD`, `PLAYWRIGHT_CHROMIUM_PATH` | test harness (see TESTING.md) |
