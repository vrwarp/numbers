import { z } from "zod";

/** Receipt-level extraction as returned by the LLM (amounts in dollars).
 *  The model transcribes what is printed — it never computes totals, never
 *  itemizes, and never assigns a ministry. The source receipt id is stamped
 *  server-side; the model never outputs it. */
/** Dollar bound for extracted amounts. Rejecting absurd magnitudes here routes
 *  a hallucinated number into the manual-entry fallback instead of overflowing
 *  integer-cents math downstream. */
const MAX_EXTRACTED_DOLLARS = 1_000_000_000;

/** True only for a real calendar date (rejects 2026-02-30, month 13, day 0). */
function isRealCalendarDate(s: string): boolean {
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

export const ModelReceiptSchema = z.object({
  merchant: z.string().trim().min(1),
  // Transcription of the printed date, never used for arithmetic — but it is
  // shown to the human and printed on the form, so it must at least be a
  // date that exists.
  purchaseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isRealCalendarDate, "not a real calendar date")
    .nullable(),
  totalAmount: z.number().finite().gt(-MAX_EXTRACTED_DOLLARS).lt(MAX_EXTRACTED_DOLLARS), // dollars, grand total as printed
  refundAmount: z
    .number()
    .finite()
    .min(0)
    .lt(MAX_EXTRACTED_DOLLARS)
    .default(0), // dollars refunded (positive), 0 if none
  summary: z.string().trim().min(1).max(200), // one-line list of what was purchased
});

export type ExtractedReceipt = z.infer<typeof ModelReceiptSchema> & { receiptId: string };
