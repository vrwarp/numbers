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
`id, firebaseUid?, email(unique), fullName?, mailingAddress?, role("member"), createdAt`
- Upserted by email at login (`/api/auth/session` after Firebase ID-token verification;
  the test-login route creates rows with `firebaseUid` NULL). `role` is currently unread
  — reserved for a treasurer feature.
- `fullName`/`mailingAddress` are stamped onto the PDF; empty is allowed (PDF prints email /
  blank), dashboard nudges the user.

### Receipt
`id, userId, filePath, mimeType, originalName, sizeBytes, status, note, merchant,
purchaseDate, extractedTotalCents?, extractedRefundCents?, createdAt`
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
- `mimeType` after upload is only `image/jpeg` (everything raster is converted) or
  `application/pdf`.
- `merchant`/`purchaseDate`/`extracted*Cents` are stamped by AI extraction at claim creation
  (empty/null until then; overwritten if the receipt is re-extracted into a new draft).
  `purchaseDate` is a transcription string ("YYYY-MM-DD" or "") — never arithmetic.
  `extractedTotalCents − extractedRefundCents` is the AI's suggested row amount; the review UI
  renders this derivation so the human verifies it against what they actually paid.
- Delete is blocked (409) while any `reimbursement_receipts` row references it.

### Reimbursement
`id, userId, status, totalCents, createdAt, updatedAt`
- **Invariant**: `totalCents == Σ amountCents of its non-excluded line items`. Recomputed in
  the line-items PATCH route and at PDF generation. If you add a mutation path, recompute.

### LineItem
`id, reimbursementId, receiptId, description, amountCents(Int), ministry, event,
isVerified, isExcluded, sortOrder, originalDescription?, originalAmountCents?`
- ONE row per receipt at claim creation (`description` composed as
  "Merchant MM/DD — summary"; `amountCents` = printed total − refunds). More rows per receipt
  exist only via Split — the multi-ministry mechanism (Merge up is the undo). There is no
  quantity column.
- `amountCents` is the ROW TOTAL. Negative ⇒ net refund (UI renders red + REFUND badge; PDF
  prints minus values; no other special-casing).
- `ministry` starts `""` — the AI never assigns one; the user must pick during review.
  Usually one of the budget categories in `MINISTRY_GROUPS` (`src/lib/ministries.ts`), but
  PATCH accepts any string ≤100 chars (the UI's "Other…" option) and refuses
  `isVerified:true` while it is empty.
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
  human-created (currently: the second half of a split). Never update them after creation —
  they are the baseline for the corrections diff.
- `sortOrder`: unique-ish ints per claim, renumbered contiguously after splits/merges. Display order
  = `sortOrder asc` within receipt groups.

### ReimbursementReceipt (join)
`@@id([reimbursementId, receiptId])` — a claim bundles many receipts. Cascade-deletes with
either side.

### ExtractionLog (telemetry — one row per extraction call, success or error)
`id, userId, reimbursementId?, model, prompt, receiptsJson, rawResponse?, parsedJson?,
status("success"|"error"), errorMessage?, durationMs, createdAt`
- `reimbursementId` is `SetNull` on claim deletion — logs must outlive claims.
- `receiptsJson` = metadata array `{id, name, mimeType}` — NEVER store image bytes.
- `parsedJson` = the receipt-level result object `{merchant, purchaseDate, totalAmount,
  refundAmount, summary, receiptId}`.
- `model` is `"mock"` under AI_MOCK.
- Written in `src/app/api/reimbursements/route.ts` (both branches). Failure meta comes from
  `ExtractionError.meta` (`src/lib/ai/extract.ts`).

### AuditEvent (telemetry — human actions)
`id, userId, reimbursementId?, lineItemId?, action, detail(JSON string), createdAt`
- `action="update"`: detail `{"changes":{field:{from,to}}}` from `computeLineItemChanges` —
  only actually-changed fields, includes isVerified/isExcluded toggles.
- `action="split"`: detail `{description, totalCents, firstAmountCents, secondAmountCents,
  newLineItemId}`.
- `action="merge"`: detail `{description, mergedLineItemId, mergedDescription,
  mergedAmountCents, targetAmountCents, resultAmountCents}` — undo-split; the merged row is
  deleted, so this is its only record (`lineItemId` points at the surviving row).
- `action="remove-receipt"`: detail `{receiptId, originalName, removedLineItems[]}` — a
  receipt pulled out of a draft claim (its rows are deleted, so this is their only record).
- `action="revert-to-draft"`: detail `{receiptIds}` — a generated claim unfrozen.
- `action="edit-receipt-image"`: detail `{receiptId, originalName, rotate, crop}` — the stored
  image was rotated/cropped in place (`/api/receipts/[id]/edit`); `reimbursementId` is set when
  the edit was made from a claim's review screen.
- `lineItemId` is a plain string (no FK) so events survive line-item deletion;
  `reimbursementId` is `SetNull`.
- If you add a new mutation route, emit an AuditEvent — the tuning pipeline assumes the trail
  is complete.

## Corrections diff (derived, not stored)

`GET /api/extraction-logs/[id]` computes per item: for each non-null `original*` field
(description, amountCents) that differs from the current value →
`corrections[field] = {from: original, to: current}`, plus `humanCreated: original* IS NULL`.
Tuning workflow reads these to find systematic model errors — "how often is the printed total
misread" is the crispest metric now that amounts are transcriptions.
