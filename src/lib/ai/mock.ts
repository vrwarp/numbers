import type { ExtractedItem } from "./schema";
import type { ReceiptInput } from "./extract";

/**
 * Deterministic extraction used when AI_MOCK=1 (tests, offline dev).
 *
 * A receipt whose original file name contains "refund" is treated as a
 * return: all quantities/amounts come back negative — exactly how the real
 * model is prompted to behave.
 */
export function mockExtract(receipts: ReceiptInput[]): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  for (const receipt of receipts) {
    const isRefund = receipt.originalName.toLowerCase().includes("refund");
    if (isRefund) {
      items.push(
        {
          receiptId: receipt.id,
          description: "KS PAPER TOWEL (RETURN)",
          quantity: -2,
          amount: -27.98,
          suggestedMinistry: "Fellowship & Hospitality",
        },
        {
          receiptId: receipt.id,
          description: "Sales Tax (Refund)",
          quantity: -1,
          amount: -2.59,
          suggestedMinistry: "Fellowship & Hospitality",
        }
      );
    } else {
      items.push(
        {
          receiptId: receipt.id,
          description: "KS PAPER TOWEL",
          quantity: 2,
          amount: 27.98,
          suggestedMinistry: "Fellowship & Hospitality",
        },
        {
          receiptId: receipt.id,
          description: "SNACK VARIETY PACK",
          quantity: 1,
          amount: 15.49,
          suggestedMinistry: "Youth (High School CE)",
        },
        {
          receiptId: receipt.id,
          description: "FOLDING TABLE 6FT",
          quantity: 1,
          amount: 49.99,
          suggestedMinistry: "Facilities",
        },
        {
          receiptId: receipt.id,
          description: "Sales Tax",
          quantity: 1,
          amount: 8.64,
          suggestedMinistry: "General Fund",
        }
      );
    }
  }
  return items;
}
