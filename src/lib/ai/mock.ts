import type { ExtractedReceipt } from "./schema";
import type { ReceiptInput } from "./extract";

/**
 * Deterministic extraction used when AI_MOCK=1 (tests, offline dev).
 *
 * A receipt whose original file name contains "refund" gets the Amazon-style
 * partial-refund fixture (net 36.31 − 5.36 = $30.95) so the derivation UI is
 * exercised; "return" gets a pure return (net −$27.98) for the REFUND badge.
 * E2E math depends on these exact numbers.
 */
export function mockExtract(receipt: ReceiptInput): ExtractedReceipt {
  const name = receipt.originalName.toLowerCase();
  if (name.includes("return")) {
    return {
      receiptId: receipt.id,
      merchant: "Costco Wholesale",
      purchaseDate: "2026-06-28",
      totalAmount: 0,
      refundAmount: 27.98,
      summary: "KS paper towel (refunded)",
    };
  }
  if (name.includes("refund")) {
    return {
      receiptId: receipt.id,
      merchant: "Amazon",
      purchaseDate: "2026-06-04",
      totalAmount: 36.31,
      refundAmount: 5.36,
      summary: "Paper plates (refunded), rulers, duct tape, clothespins",
    };
  }
  return {
    receiptId: receipt.id,
    merchant: "Costco Wholesale",
    purchaseDate: "2026-06-21",
    totalAmount: 102.1,
    refundAmount: 0,
    summary: "Paper towels, snack variety pack, 6ft folding table",
  };
}
