# Data model reference

Schema: `prisma/schema.prisma`. SQLite. After editing: `npx prisma migrate dev --name <name>`
and commit the generated migration. IDs are cuid strings.

## State machines

```
Receipt.status:        "unassigned" ──(claim PDF generated)──▶ "processed"
Reimbursement.status:  "draft"      ──(PDF generated)────────▶ "generated"   (frozen)
                          ◀──────────(revert to draft)──────────┘  (both transitions reversed)
```

- Any owned receipt can join a new claim regardless of status (multi-claim receipts are a
  feature); `processed` only records that ≥1 generated claim holds it.
- Deleting a draft claim cascades its line items and join rows; receipts revert to being
  selectable (their status never left `unassigned` — status changes only at PDF generation).
- `generated` claims: line-item PATCH/split/merge → 409; DELETE claim → 409; PDF re-download allowed.
- POST `/api/reimbursements/[id]/revert` (generated only, 409 else) is the escape hatch for
  mistakes noticed before the printed form is filed: claim → draft, its receipts →
  unassigned, AuditEvent(revert-to-draft). Rows keep `isVerified` — values were frozen at
  generation, so the attestations hold until edited.

## Tables

### User
`id, firebaseUid?, email(unique), fullName?, mailingAddress?, role("member"),
esignAllowed(false), approvalsPaused(false), financePaused(false), adminPaused(false),
locale("en"), printIncludeReceipts(false), printIncludeCertificate(false), createdAt`
- Upserted by email at login (`/api/auth/session` after Firebase ID-token verification;
  the test-login route creates rows with `firebaseUid` NULL).
- `role` = `member | approver | secretary | chairman | treasurer | admin` — the
  VERIFIED roster mirror (docs/ESIGN_DESIGN.md §5.5): written only from
  signature-verified GRANT_ROLE/REVOKE_ROLE replay (highest active grant by
  `ROLE_RANK`), never by hand. Gates app surfaces (queues, pickers, admin; the
  executive-officer roles — chairman/secretary/treasurer — gate the vouch
  screen's role controls, A11); the roster is the signed truth.
- `esignAllowed` — A8 rollout allowlist flag (admin-managed app gate; never validity).
- `approvalsPaused` / `financePaused` / `adminPaused` — A10 self-service duty pauses,
  toggled by the member on their own profile (audited `update-availability`). App
  routing only: paused approvers leave the picker and refuse NEW submissions but keep
  already-assigned claims; paused treasurers lose queue+mark-paid; paused admins fail
  `isAppAdmin()` everywhere. Never a role change, invisible to ledger validity, and
  independent of the role — the flags survive role churn.
- `fullName`/`mailingAddress` are stamped onto the PDF; empty is allowed (PDF prints email /
  blank), dashboard nudges the user.
- `printIncludeReceipts` / `printIncludeCertificate` — the treasurer batch-print toolbar's
  two content toggles (docs/ESIGN_DESIGN.md §6.1), persisted so the choice follows the
  account across devices. Both default OFF (lean CFCC-forms-only output). Plain UI
  preference: read/written via `GET`/`PATCH /api/profile`, not audited, and never trusted
  by the print route (which re-derives ids/content per request).

### Receipt
`id, userId, filePath, originalFilePath?, mimeType, originalName, sizeBytes, status, note,
merchant, purchaseDate, extractedTotalCents?, extractedRefundCents?, createdAt`
- A receipt may join ANY number of claims (a purchase split across filings).
  `status="processed"` is a cache meaning "on ≥1 GENERATED claim", maintained at PDF
  generation and revert (revert releases a receipt only if no other generated claim holds
  it). Processed receipts stay selectable in the Shoebox; each new claim re-extracts and
  overwrites the extraction metadata below.
- `note` is the user's optional description (set at upload, editable via PATCH any time,
  never touched by the AI). Shown on the Shoebox card, both review headers, and appended to
  the PDF appendix page label.
- `filePath` is RELATIVE to `DATA_DIR` (e.g. `uploads/<userId>/<id>.jpg`). Resolve/read only
  through `src/lib/storage.ts` (traversal guard).
- `originalFilePath` is NULL until the rotate/crop tool first overwrites `filePath`, at which
  point the pristine upload is copied to a sidecar (`<id>.orig.<ext>`) so the editor's "Restore
  original" can put it back. Stays set across further edits (it always points at the first
  upload); deleted alongside the receipt.
- `mimeType` after upload is only `image/jpeg` (everything raster is converted) or
  `application/pdf`.
- `merchant`/`purchaseDate`/`extracted*Cents` are stamped by AI extraction at claim creation
  (empty/null until then; overwritten if the receipt is re-extracted into a new draft).
  `purchaseDate` is a transcription string ("YYYY-MM-DD" or "") — never arithmetic.
  `extractedTotalCents − extractedRefundCents` is the AI's suggested row amount; the review UI
  renders this derivation so the human verifies it against what they actually paid.
- Delete is blocked (409) while any `reimbursement_receipts` row references it.

### Reimbursement
`id, userId, status, totalCents, singleMinistry, claimMinistry, claimEvent, claimDescription,
publicToken?, createdAt, updatedAt`
- **Invariant**: `totalCents == Σ amountCents of its non-excluded line items`. Recomputed in
  the line-items PATCH route and at PDF generation. If you add a mutation path, recompute.
- `singleMinistry` (default `true`; existing claims were migrated to `false`): the claim uses
  one ministry/event for every row. `claimMinistry`/`claimEvent` are the claim-level values;
  the claim PATCH route MIRRORS them onto every non-excluded row whenever they change (or the
  mode turns on), un-verifying and audit-logging each touched row. This is a **mirror, not a
  lock**: `LineItem.ministry` stays the source of truth for the PDF, and direct row PATCHes
  are still accepted (the UI just doesn't offer them in single mode). Rows created later
  (add-receipts) or un-excluded inherit the claim values at that moment. Switching multi →
  single without an explicit value adopts `mostCommonMinistryEvent(rows)`.
- `claimDescription`: the user's one-sentence "what is this claim for" — the input to the
  suggestion call (`POST …/suggest`), kept as a human-readable claim note.
- `publicToken` (unique, NULL until first PDF generation): 24 random bytes base64url — the
  capability credential behind `GET /c/<token>`, which serves the claim's latest stored packet
  (`generated/<userId>/<claimId>.pdf`) with no sign-in. NEVER derive it from the claim id.
  It is minted once and kept through revert/re-generate cycles so a QR printed on any earlier
  version keeps resolving to the newest packet.

### LineItem
`id, reimbursementId, receiptId, description, amountCents(Int), ministry, event,
isVerified, isExcluded, sortOrder, originalDescription?, originalAmountCents?`
- ONE row per receipt at claim creation (`description` composed as
  "Merchant MM/DD — summary"; `amountCents` = printed total − refunds). More rows per receipt
  exist only via Split — the multi-ministry mechanism (Merge up is the undo). There is no
  quantity column.
- `amountCents` is the ROW TOTAL. Negative ⇒ net refund (UI renders red + REFUND badge; PDF
  prints minus values; no other special-casing).
- `ministry` starts `""` — the AI never assigns one (the suggestion feature only proposes; a
  human applies it via the claim PATCH); the user must pick during review, per row or through
  single-ministry mode's claim-level control. Usually one of the budget categories in
  `MINISTRY_GROUPS` (`src/lib/ministries.ts`), but PATCH accepts any string ≤100 chars (the
  UI's "Other…" option) and refuses `isVerified:true` while it is empty.
- `event` is optional free text (default `""`, ≤100 chars, never required). Printed with
  the ministry on the PDF's "For Ministry / Event" column via `formatMinistryEvent`
  (`"<ministry> — <event>"`).
- **Verification semantics** (the core product rule):
  - PDF gate: every row with `isExcluded=false` must have `isVerified=true` and a
    non-empty `ministry`.
  - Any content change (description/amountCents/ministry/event) resets `isVerified=false`
    unless the same patch explicitly sets `isVerified`.
  - Excluding sets the row aside entirely (no verification needed, not on the PDF, out of all
    totals). UI also sets `isVerified:false` when toggling exclusion.
- **original\* columns**: frozen copy of the AI extraction at claim creation. NULL ⇒ row was
  human-created: the second half of a split, or a failed-extraction/manual placeholder (the AI
  produced nothing to freeze; an empty `description` on such a row is the review UI's cue to
  prompt for manual entry). Never update them after creation — they are the baseline for the
  corrections diff.
- `sortOrder`: unique-ish ints per claim, renumbered contiguously after splits/merges. Display order
  = `sortOrder asc` within receipt groups.

### ReimbursementReceipt (join)
`@@id([reimbursementId, receiptId])` — a claim bundles many receipts. Cascade-deletes with
either side.

### ExtractionLog (telemetry — one row per AI call, success or error)
`id, userId, reimbursementId?, kind("receipt"|"suggestion"), model, prompt, receiptsJson?,
rawResponse?, parsedJson?, status("success"|"error"), errorMessage?, durationMs, createdAt`
- `reimbursementId` is `SetNull` on claim deletion — logs must outlive claims.
- `kind="receipt"` (vision extraction): `receiptsJson` = metadata array `{id, name, mimeType}`
  — NEVER store image bytes; `parsedJson` = the receipt-level result `{merchant, purchaseDate,
  totalAmount, refundAmount, summary, receiptId}`. Written by the claim-building routes
  (create claim, add receipts to a draft) via `src/lib/claims.ts` (success and failure
  branches); failure meta comes from `ExtractionError.meta` (`src/lib/ai/extract.ts`).
- `kind="suggestion"` (text-only ministry suggestion): `receiptsJson` NULL, the user's
  sentence travels inside `prompt`, `parsedJson` = `{ministry, event, rationale}`. Written by
  `POST /api/reimbursements/[id]/suggest` (success and failure).
- `model` is `"mock"` under AI_MOCK.

### AuditEvent (telemetry — human actions)
`id, userId, reimbursementId?, lineItemId?, action, detail(JSON string), createdAt`
- `action="update"`: detail `{"changes":{field:{from,to}}}` from `computeLineItemChanges` —
  only actually-changed fields, includes isVerified/isExcluded toggles. Rows touched by a
  single-ministry fan-out get the same shape plus `source:"claim-ministry"`.
- `action="update-claim"`: detail `{"changes":{field:{from,to}}}` over the claim-level review
  settings (singleMinistry/claimMinistry/claimEvent/claimDescription).
- `action="split"`: detail `{description, totalCents, firstAmountCents, secondAmountCents,
  newLineItemId}`.
- `action="merge"`: detail `{description, mergedLineItemId, mergedDescription,
  mergedAmountCents, targetAmountCents, resultAmountCents}` — undo-split; the merged row is
  deleted, so this is its only record (`lineItemId` points at the surviving row).
- `action="add-receipt"`: detail `{addedReceipts: [{receiptId, originalName, description,
  amountCents}]}` — receipts appended to a draft claim after creation
  (`POST /api/reimbursements/[id]/receipts`; one line item each, same AI extraction as create).
- `action="manual-entry"`: detail `{receiptId, merchant, changes}` — the user filled in a
  failed-extraction placeholder by hand (`PATCH /api/reimbursements/[id]/receipts/[receiptId]`);
  `changes` is the `computeLineItemChanges` diff (empty → composed description/amount).
- `action="remove-receipt"`: detail `{receiptId, originalName, removedLineItems[]}` — a
  receipt pulled out of a draft claim (its rows are deleted, so this is their only record).
- `action="revert-to-draft"`: detail `{receiptIds}` — a generated claim unfrozen.
- `action="restore-receipt-image"`: detail `{receiptId, originalName}` — the stored image was
  reset to the pristine upload (`/api/receipts/[id]/edit` with `{restore:true}` and no transform).
- `action="edit-receipt-image"`: detail `{receiptId, originalName, rotate, crop}` (plus
  `fromOriginal:true` when the transform was applied to a staged reset) — the stored image was
  rotated/cropped (`/api/receipts/[id]/edit`); `reimbursementId` is set when
  the edit was made from a claim's review screen.
- `lineItemId` is a plain string (no FK) so events survive line-item deletion;
  `reimbursementId` is `SetNull`.
- If you add a new mutation route, emit an AuditEvent — the tuning pipeline assumes the trail
  is complete.

### EmbeddingSettings / Embedding / EmbeddingJob (semantic search — docs/SEARCH_DESIGN.md)
- `EmbeddingSettings`: single row, admin-editable backend config (endpoint/key/model/
  dim/queryPrefix/minScoreMilli). Seeded once from `EMBEDDING_*` config; thereafter the
  DB row is authoritative. The admin GET returns a key FINGERPRINT, never the key.
  Model/dim change = wipe both tables + rebuild sweep.
- `Embedding`: one vector per (kind, targetId, model); denormalized userId/year so
  search scans one table join-free; `sourceSha256` = fingerprint of the FULL embedding
  input rebuilt from DB columns (receipt: fileSha256‖note‖merchant‖purchaseDate;
  claim: composite text). No FKs — routes delete alongside targets, the sweep GCs.
- `EmbeddingJob`: durable queue; upsert-per-(kind,targetId,model) with `generation++`
  (the worker's terminal write is generation-conditional — racing enqueues never lose);
  draft debounce = `nextAttemptAt = now + EMBEDDING_DRAFT_IDLE_MS`; `failedSourceSha256`
  keeps failed jobs stable until content changes. Receipt gains `fileSha256` (stamped at
  upload/edit/restore + lazily at first embed).

### SearchHistory (recent searches — docs/SEARCH_DESIGN.md §7)
`id, userId, query, createdAt, updatedAt` — unique `(userId, query)`, indexed
`(userId, updatedAt)`. Per-user recent-search history backing the "Recent searches"
dropdown, synced across the member's devices. One row per distinct query; a re-search
upserts and bumps `updatedAt` (float-to-top). Written best-effort by `POST /api/search`
(never gates the search); read/cleared via `GET`/`DELETE /api/search/history`. Pruned to
a 90-day window on write and re-filtered on read. Strictly owner-scoped (invariant 2) —
the user's own history shown back to them, NOT telemetry, so it never lands in
`ExtractionLog` (the queries-are-PII rule for logs is unchanged).

## Corrections diff (derived, not stored)

`GET /api/extraction-logs/[id]` computes per item: for each non-null `original*` field
(description, amountCents) that differs from the current value →
`corrections[field] = {from: original, to: current}`, plus `humanCreated: original* IS NULL`.
Tuning workflow reads these to find systematic model errors — "how often is the printed total
misread" is the crispest metric now that amounts are transcriptions.
