import { MINISTRIES } from "@/lib/config";

export function buildExtractionPrompt(receiptIds: string[]): string {
  return `You are a receipt data extraction engine for a church reimbursement system.

You will receive ${receiptIds.length} receipt document(s). Each document is preceded by a text marker "RECEIPT ID: <id>" identifying it. The receipt ids, in order, are:
${receiptIds.map((id, i) => `${i + 1}. ${id}`).join("\n")}

Extract ALL line items from every receipt, following these rules exactly:
1. Extract line items exactly as they appear on the receipt (keep original descriptions, abbreviations included).
2. Output Taxes and Fees as their own dedicated line items (e.g. "Sales Tax", "Delivery Fee").
3. Identify returns/refunds and represent them as NEGATIVE quantities and NEGATIVE amounts.
4. "amount" is the line total in dollars (unit price x quantity), not the unit price.
5. Suggest the most likely ministry for each item from this list: ${MINISTRIES.join(", ")}. If unsure, use "General Fund".

Respond with ONLY a JSON array (no markdown, no commentary) where each element is:
{"receiptId": "<the RECEIPT ID marker of the source document>", "description": "...", "quantity": 1, "amount": 12.34, "suggestedMinistry": "..."}`;
}
