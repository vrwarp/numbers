# Migration plan: totals-first extraction

*Status: IMPLEMENTED (migration `20260704004229_totals_first_extraction`). Kept as the design
rationale record. Backward compatibility was explicitly not required — the migration drops
`LineItem.quantity`/`originalQuantity`.*

## Goal

Replace per-line-item receipt extraction with **one line item per receipt**:

- The model extracts `{merchant, purchaseDate, totalAmount, refundAmount, summary}` — reading
  printed numbers, not reconstructing an itemization. Per-merchant format quirks (Amazon
  refund sections, pooled tax lines, shipping rebates) stop mattering.
- The row's amount is the **net total** (`total − refunds`); the UI shows the derivation
  ("charged $36.31 − refunded $5.36") so the human verifies a derivation, not a bare number.
- The model's item-reading ability is spent on the **description**, not the amounts:
  `Amazon 06/04 — rulers, duct tape, cotton balls, clothespins`.
- Multi-ministry receipts use the existing **Split** operation (amount-based, both halves
  unverified) — no itemized extraction mode is kept.

Every hard invariant survives: integer cents, verify-with-ministry gate, edit-revokes-
verification, server-side `totalCents` recompute, status machines, ExtractionLog/AuditEvent/
`original*` telemetry, AcroForm field-name contract (the PDF template is untouched).

---

## 1. Data model (`prisma/schema.prisma` + one migration)

### Receipt — add extraction-stamped metadata

```prisma
model Receipt {
  // ... existing fields ...
  // Stamped by extraction at claim creation; empty/null until then.
  merchant            String  @default("")
  purchaseDate        String  @default("")   // "YYYY-MM-DD" as printed; "" if unreadable
  extractedTotalCents  Int?   // grand total as printed on the receipt
  extractedRefundCents Int?   // total refunded (positive), 0 when none
}
```

Rationale: merchant/date/totals are properties of the *document*, shared by all rows that
receipt produces (including split halves). `purchaseDate` is a string on purpose — it is a
transcription of what is printed, never used for arithmetic, and avoids timezone drift.
`extracted*Cents` exist solely so the review UI can render the net-amount derivation; they are
overwritten if the receipt is re-extracted into a new draft (allowed today via the join table).

### LineItem — drop quantity

```prisma
model LineItem {
  // REMOVE: quantity            Float  @default(1)
  // REMOVE: originalQuantity    Float?
  // everything else unchanged
}
```

Quantity is meaningless for a whole-receipt row (and for a split half). The PDF's quantity
column is simply left blank (§6). `originalDescription`/`originalAmountCents` keep their exact
semantics: frozen AI values, `NULL` ⇒ human-created row (split's second half).

Run `npx prisma migrate dev --name totals_first_extraction`; commit the migration. SQLite will
rewrite the line_items table to drop the columns — fine, no compat requirement.

---

## 2. AI layer (`src/lib/ai/*`)

### `schema.ts` — object result, not array

```ts
export const ModelReceiptSchema = z.object({
  merchant: z.string().min(1),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), // null = not readable
  totalAmount: z.number().finite(),        // dollars, grand total as printed
  refundAmount: z.number().finite().min(0).default(0), // dollars refunded, 0 if none
  summary: z.string().min(1).max(200),     // short list of what was purchased
});
export type ExtractedReceipt = z.infer<typeof ModelReceiptSchema> & { receiptId: string };
```

`ExtractedItem` and `ModelItemSchema`/`ModelResultSchema` are deleted; every import site
(extract.ts, mock.ts, parse.ts, reimbursements route) updates.

### `prompt.ts` — rewrite

New contract (single JSON **object**, no markdown):

1. `merchant`: store/vendor name as printed.
2. `purchaseDate`: purchase/order date as `YYYY-MM-DD`, or `null` if not readable.
3. `totalAmount`: the grand total in dollars **as printed** (after tax, shipping, discounts).
   Do not compute it — transcribe it.
4. `refundAmount`: total refunded/returned in dollars as a **positive** number (include the
   refunded tax share when the receipt states it, e.g. Amazon "Refund Total"); `0` if none.
5. `summary`: one line (≤ ~120 chars) listing the notable items purchased, e.g.
   `"rulers, duct tape, cotton balls, clothespins"`. Abbreviations from the receipt are fine.
   Note refunded items with "(refunded)".

Keep the existing header ("receipt data extraction engine for a church reimbursement
system"), the one-receipt-per-call comment block, and the no-ministry rule.

### `parse.ts` — object extraction

`extractJsonArray` becomes `extractJsonObject` (first `{` to last `}`, same fence/prose
stripping); validate with `ModelReceiptSchema`; return one `ExtractedReceipt` stamped with the
server-side receipt id. The "contained no line items" error disappears (zod's min(1) on
merchant/summary covers degenerate output).

### `extract.ts` — type rename only

`ReceiptExtraction.items: ExtractedItem[] | null` → `result: ExtractedReceipt | null`.
Concurrency, ExtractionError, meta capture, mapWithConcurrency: unchanged.

### `mock.ts` — one result per receipt

Deterministic values (e2e math is rebuilt on these — see §7):

- default: `{merchant: "Costco Wholesale", purchaseDate: "2026-06-21", totalAmount: 102.10,
  refundAmount: 0, summary: "Paper towels, snack variety pack, 6ft folding table"}`
- filename contains `"refund"`: `{merchant: "Amazon", purchaseDate: "2026-06-04",
  totalAmount: 36.31, refundAmount: 5.36, summary: "Paper plates (refunded), rulers, duct
  tape"}` → net **$30.95**, exercising the derivation UI and a partial-refund receipt.

(If a fully-negative row is still wanted for the REFUND badge e2e, add a second trigger word,
e.g. `"return"` → `totalAmount: 0, refundAmount: 27.98` → net −$27.98.)

---

## 3. Claim creation (`src/app/api/reimbursements/route.ts`)

Per successful outcome, build **one** line item:

```ts
const totalCents  = parseDollarsToCents(r.totalAmount);
const refundCents = parseDollarsToCents(r.refundAmount);
const netCents    = totalCents - refundCents;
const description = composeDescription(r); // "Amazon 06/04 — rulers, duct tape, ..." ; date part omitted when null
```

- `description` composition lives in a small helper next to the route (or `src/lib/ai/`),
  formatting the date as `MM/DD` and truncating to the PATCH route's 300-char cap.
- LineItem: `{receiptId, description, amountCents: netCents, ministry: "", sortOrder: i,
  originalDescription: description, originalAmountCents: netCents}` — no quantity.
- In the same transaction as `reimbursement.create`, update each Receipt with
  `merchant`, `purchaseDate ?? ""`, `extractedTotalCents`, `extractedRefundCents`.
- `parsedJson` in the ExtractionLog now stores the extracted object (same column, new shape).
- All-or-nothing failure handling, dedupe, ownership/status checks: unchanged.

---

## 4. Review-time routes

### `line-items/[id]` PATCH
- Remove `quantity` from `PatchSchema` and from the `contentChanged` field list.
- Everything else (ministry-before-verify, edit-revokes-verification, totalCents recompute,
  AuditEvent) is untouched.

### `line-items/[id]/split` POST
- Drop `quantity: item.quantity` from the created row. No other change — split is now the
  primary multi-ministry mechanism, semantics already correct.

### `src/lib/audit.ts`
- Remove `"quantity"` from `TRACKED_FIELDS`.

### `extraction-logs/[id]` GET
- Remove the `originalQuantity` corrections block. `humanCreated` and the
  description/amount diffs stand — "how often does the model misread the printed total" is
  now the crispest tuning metric.

### `reimbursements/[id]` GET
- Include the new Receipt fields in the receipts join (they ride along automatically with
  Prisma unless a select narrows them — verify).

---

## 5. Review UI (`src/components/ReviewClaim.tsx`)

- Local `LineItem` interface: drop `quantity`. `ReceiptRef.receipt` gains
  `merchant, purchaseDate, extractedTotalCents, extractedRefundCents`.
- **Group header**: show `merchant — MM/DD/YYYY` (fall back to originalName) so the human can
  match the pane to the photo at a glance; keep the subtotal (redundant for a single row,
  meaningful again after a split).
- **Derivation note** (the heart of option 2): when `extractedRefundCents > 0`, render inside
  the group, above the row:
  `Charged $36.31 − refunded $5.36 → suggested $30.95` (all via `formatCents`). Static text —
  the editable truth stays the row's amount field.
- **Row**: description becomes a `<textarea rows={2}>` (composed descriptions are longer);
  remove the Qty input; ministry select, amount input, verify/split/exclude buttons, REFUND
  badge (net < 0) all unchanged.
- Guidance copy: "Check the amount against what you actually paid, pick a ministry, then
  check it off." Exclude button title stays valid (excluding a row = excluding a receipt's
  whole claim); personal-item adjustments are now "edit the amount down and note it in the
  description".

`Shoebox.tsx`, dashboard, claims list: no changes required (counts/totals only). Optional
nicety, not in scope: show merchant/date on processed receipts in the shoebox.

---

## 6. PDF (`src/lib/pdf/*`)

- **Template and field names: untouched.** One row per receipt means most claims fit one
  13-row page; pagination code stays as the >13-receipts path.
- `PdfLineItem`: drop `quantity`; `generate.ts` stops setting
  `Description QuantityRow{n}_2` (or sets `""`); delete `formatQty`.
- Description now carries merchant + date + summary at font size 8. After implementation,
  render a sample with `scripts/render-pdf.mjs` and eyeball; if long summaries overflow the
  single-line field, tighten the prompt's summary cap (the 300-char DB cap is not the visual
  cap) or drop the field font size to 7 — decide by looking, not preemptively.

---

## 7. Tests

Unit (`tests/unit`):
- `ai-parse.test.ts` — rewrite for object parsing: fences, prose, missing keys, bad date
  format, negative refund rejected, refund defaulting to 0, hallucinated receipt id ignored.
- `audit.test.ts` — remove quantity cases.
- `pdf.test.ts` — no quantity assertions; assert composed description and blank qty cell;
  totals math unchanged (net cents in → same rendering).
- `paginate.test.ts`, `money.test.ts`, `image.test.ts`, `session.test.ts` — untouched.
- `extract-meta.test.ts` / `extract-providers.test.ts` — type rename fallout only.

E2E (`tests/e2e`, math rebuilt on the §2 mock):
- `journey.spec.ts` — the flagship walk becomes: upload 2 receipts (one `refund`-named) →
  generate claim → totals: 102.10 + 30.95 = **$133.05** → verify derivation note text →
  edit-amount-down scenario replaces the old tax-adjust scenario (e.g. Costco row
  102.10 → 90.00, claim $120.95, row unverifies) → split conserves totals → exclude receipt
  row → ministry-gate → PDF page count = 1 form page + receipt pages, telemetry assertions
  (corrections diff on amount edit, split audit event).
- Pagination scenario: needs **14 receipts** now (1 row each) instead of 4-item receipts;
  keep it, it's the only >1-form-page coverage.
- `mobile.spec.ts` / `security.spec.ts` — mock-number and selector fallout only
  (`qty-*` testids disappear).

---

## 8. Docs (same PR, not after)

- `CLAUDE.md` — invariant 7 (drop quantity from original*), add "one line item per receipt at
  creation; Split is the multi-ministry mechanism".
- `docs/agent/ARCHITECTURE.md` — prompt/schema/parse file notes, claim-creation flow, route
  table (PATCH fields), Receipt fields.
- `docs/agent/DATA_MODEL.md` — Receipt/LineItem tables, corrections diff.
- `docs/DESIGN.md` — Phase 2/3 narrative, decision log entry: *"Totals-first extraction —
  per-item extraction was finicky across merchant formats (Amazon refunds especially) and
  itemization only matters for the rare multi-ministry receipt, which Split already covers.
  The model transcribes printed totals; humans verify a derivation."* The "Adjust tax" row in
  the Phase 3 table is replaced by "edit the amount down".
- `docs/agent/CONVENTIONS.md` / `TESTING.md` / `PLAYBOOKS.md` — mock numbers, e2e math notes.

---

## 9. Suggested commit sequence (one PR, reviewable steps)

1. Schema + migration (Receipt fields, LineItem column drops).
2. AI layer: schema/prompt/parse/mock/extract (unit tests for parse alongside).
3. Claim-creation route + description composer.
4. Review-time routes + audit + corrections endpoint.
5. PDF quantity removal.
6. ReviewClaim UI.
7. E2E rebuild + remaining unit fallout.
8. Docs.

Validation gate: `npm run build && npm test`, then
`E2E_BROWSERS=chromium npm run test:e2e`, then `scripts/render-pdf.mjs` on a generated packet
to eyeball description legibility on the form.

## Out of scope (deliberately)

- Any per-item extraction mode or "itemize this receipt" button — add later only if reality
  demands it.
- Merchant/date editing UI (they only feed the composed description and group header; the
  description itself stays editable).
- Backfill of existing rows; old claims keep whatever they have.
