import { z } from "zod";

/** Receipt-level extraction as returned by the LLM (amounts in dollars).
 *  The model transcribes what is printed — it never computes totals, never
 *  itemizes, and never assigns a ministry. The source receipt id is stamped
 *  server-side; the model never outputs it. */
export const ModelReceiptSchema = z.object({
  merchant: z.string().min(1),
  // Transcription of the printed date, never used for arithmetic.
  purchaseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  totalAmount: z.number().finite(), // dollars, grand total as printed
  refundAmount: z.number().finite().min(0).default(0), // dollars refunded (positive), 0 if none
  summary: z.string().min(1).max(200), // one-line list of what was purchased
});

export type ExtractedReceipt = z.infer<typeof ModelReceiptSchema> & { receiptId: string };
