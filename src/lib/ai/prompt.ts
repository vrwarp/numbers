// One receipt per call: small vision models attribute values unreliably when
// several documents share a context, so each receipt gets its own request and
// the server stamps the receipt id (the model never has to echo ids back).
// The model only transcribes what is printed on the receipt — it never
// computes totals, and assigning a ministry is a human decision made during
// review, never an AI guess.
export function buildExtractionPrompt(): string {
  return `You are a receipt data extraction engine for a church reimbursement system.

You will receive one receipt document. Extract its overall details, following these rules exactly:
1. "merchant": the store/vendor name as printed on the receipt.
2. "purchaseDate": the purchase or order date as "YYYY-MM-DD", or null if no date is readable.
3. "totalAmount": the grand total in dollars AS PRINTED (after tax, shipping, discounts). Transcribe it — do not compute it.
4. "refundAmount": the total refunded/returned in dollars as a POSITIVE number, including the refunded tax share when the receipt states it (e.g. a "Refund Total" line). Use 0 if nothing was refunded.
5. "summary": one line (under 120 characters) listing the notable items purchased, e.g. "rulers, duct tape, cotton balls, clothespins". Keep the receipt's abbreviations; mark refunded items with "(refunded)".

Respond with ONLY a JSON object (no markdown, no commentary):
{"merchant": "...", "purchaseDate": "2026-06-04", "totalAmount": 36.31, "refundAmount": 5.36, "summary": "..."}`;
}
