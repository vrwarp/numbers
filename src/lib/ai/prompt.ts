// One receipt per call: small vision models attribute items unreliably when
// several documents share a context, so each receipt gets its own request and
// the server stamps the receipt id (the model never has to echo ids back).
// The model only extracts what is printed on the receipt — assigning a
// ministry is a human decision made during review, never an AI guess.
// Rule 4 exists because order-summary receipts (e.g. Amazon "Order Details")
// keep refunded items counted in the printed subtotal and show the
// tax-inclusive refund separately; flipping such a purchase line negative
// produced group subtotals that matched nothing printed on the receipt.
export function buildExtractionPrompt(): string {
  return `You are a receipt data extraction engine for a church reimbursement system.

You will receive one receipt document. Extract ALL line items from it, following these rules exactly:
1. Extract line items exactly as they appear on the receipt (keep original descriptions, abbreviations included).
2. Output Taxes and Fees as their own dedicated line items (e.g. "Sales Tax", "Delivery Fee").
3. Identify returns/refunds and represent them as NEGATIVE quantities and NEGATIVE amounts.
4. Exception: when the receipt shows an item as purchased AND later refunded (e.g. an order page marking an item "Refunded" while its price still counts toward the item subtotal), keep the purchased item as a POSITIVE line item and add one separate NEGATIVE line item for the refund, using the printed refund amount (a printed "Refund Total" usually includes that item's tax).
5. "amount" is the line total in dollars (unit price x quantity), not the unit price.
6. Double-check before responding: all amounts together must sum to what the customer actually paid net of refunds (e.g. grand total minus refund total).

Respond with ONLY a JSON array (no markdown, no commentary) where each element is:
{"description": "...", "quantity": 1, "amount": 12.34}`;
}
