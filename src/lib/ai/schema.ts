import { z } from "zod";

/** One line item as returned by the LLM (amounts in dollars). The source
 *  receipt id is stamped server-side — the model never outputs it. */
export const ModelItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().finite(),
  amount: z.number().finite(), // dollars; negative for returns/refunds
  suggestedMinistry: z.string().default(""),
});

export const ModelResultSchema = z.array(ModelItemSchema);

export type ExtractedItem = z.infer<typeof ModelItemSchema> & { receiptId: string };
