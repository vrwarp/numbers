import { z } from "zod";

/** One line item as returned by the LLM (amounts in dollars). */
export const ExtractedItemSchema = z.object({
  receiptId: z.string().min(1),
  description: z.string().min(1),
  quantity: z.number().finite(),
  amount: z.number().finite(), // dollars; negative for returns/refunds
  suggestedMinistry: z.string().default(""),
});

export const ExtractionResultSchema = z.array(ExtractedItemSchema);

export type ExtractedItem = z.infer<typeof ExtractedItemSchema>;
