# Data model reference

Schema: `prisma/schema.prisma`. SQLite. After editing: `npx prisma migrate dev --name <name>`
and commit the generated migration. IDs are cuid strings.

## State machines

```
Receipt.status:        "unassigned" ──(claim PDF generated)──▶ "processed"
Reimbursement.status:  "draft"      ──(PDF generated)────────▶ "generated"   (frozen)
```

- Only `unassigned` receipts can join a new claim (POST /api/reimbursements 409s otherwise).
- Deleting a draft claim cascades its line items and join rows; receipts revert to being
  selectable (their status never left `unassigned` — status changes only at PDF generation).
- `generated` claims: line-item PATCH/split → 409; DELETE claim → 409; PDF re-download allowed.

## Tables

### User
`id, firebaseUid?, email(unique), fullName?, mailingAddress?, role("member"), createdAt`
- Upserted by email at login (`/api/auth/session` after Firebase ID-token verification;
  the test-login route creates rows with `firebaseUid` NULL). `role` is currently unread
  — reserved for a treasurer feature.
- `fullName`/`mailingAddress` are stamped onto the PDF; empty is allowed (PDF prints email /
  blank), dashboard nudges the user.

### Receipt
`id, userId, filePath, mimeType, originalName, sizeBytes, status, createdAt`
- `filePath` is RELATIVE to `DATA_DIR` (e.g. `uploads/<userId>/<id>.jpg`). Resolve/read only
  through `src/lib/storage.ts` (traversal guard).
- `mimeType` after upload is only `image/jpeg` (everything raster is converted) or
  `application/pdf`.
- Delete is blocked (409) while any `reimbursement_receipts` row references it.

### Reimbursement
`id, userId, status, totalCents, createdAt, updatedAt`
- **Invariant**: `totalCents == Σ amountCents of its non-excluded line items`. Recomputed in
  the line-items PATCH route and at PDF generation. If you add a mutation path, recompute.

### LineItem
`id, reimbursementId, receiptId, description, quantity(Float), amountCents(Int), ministry,
isVerified, isExcluded, sortOrder, originalDescription?, originalQuantity?,
originalAmountCents?`
- `amountCents` is the LINE TOTAL (not unit price). Negative ⇒ refund (UI renders red +
  REFUND badge; PDF prints minus values; no other special-casing).
- `quantity` may be fractional or negative.
- `ministry` starts `""` — the AI never assigns one; the user must pick during review.
  Should be one of `MINISTRIES` (`src/lib/ministries.ts`); PATCH accepts any string ≤100 chars
  (UI only offers the list) but refuses `isVerified:true` while it is empty.
- **Verification semantics** (the core product rule):
  - PDF gate: every row with `isExcluded=false` must have `isVerified=true` and a
    non-empty `ministry`.
  - Any content change (description/quantity/amountCents/ministry) resets `isVerified=false`
    unless the same patch explicitly sets `isVerified`.
  - Excluding sets the row aside entirely (no verification needed, not on the PDF, out of all
    totals). UI also sets `isVerified:false` when toggling exclusion.
- **original\* columns**: frozen copy of the AI extraction at claim creation. NULL ⇒ row was
  human-created (currently: the second half of a split). Never update them after creation —
  they are the baseline for the corrections diff.
- `sortOrder`: unique-ish ints per claim, renumbered contiguously after splits. Display order
  = `sortOrder asc` within receipt groups.

### ReimbursementReceipt (join)
`@@id([reimbursementId, receiptId])` — a claim bundles many receipts. Cascade-deletes with
either side.

### ExtractionLog (telemetry — one row per extraction call, success or error)
`id, userId, reimbursementId?, model, prompt, receiptsJson, rawResponse?, parsedJson?,
status("success"|"error"), errorMessage?, durationMs, createdAt`
- `reimbursementId` is `SetNull` on claim deletion — logs must outlive claims.
- `receiptsJson` = metadata array `{id, name, mimeType}` — NEVER store image bytes.
- `model` is `"mock"` under AI_MOCK.
- Written in `src/app/api/reimbursements/route.ts` (both branches). Failure meta comes from
  `ExtractionError.meta` (`src/lib/ai/extract.ts`).

### AuditEvent (telemetry — human actions)
`id, userId, reimbursementId?, lineItemId?, action, detail(JSON string), createdAt`
- `action="update"`: detail `{"changes":{field:{from,to}}}` from `computeLineItemChanges` —
  only actually-changed fields, includes isVerified/isExcluded toggles.
- `action="split"`: detail `{description, totalCents, firstAmountCents, secondAmountCents,
  newLineItemId}`.
- `lineItemId` is a plain string (no FK) so events survive line-item deletion;
  `reimbursementId` is `SetNull`.
- If you add a new mutation route, emit an AuditEvent — the tuning pipeline assumes the trail
  is complete.

## Corrections diff (derived, not stored)

`GET /api/extraction-logs/[id]` computes per item: for each non-null `original*` field that
differs from the current value → `corrections[field] = {from: original, to: current}`, plus
`humanCreated: original* IS NULL`. Tuning workflow reads these to find systematic model errors.
