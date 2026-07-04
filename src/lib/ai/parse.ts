import { ModelReceiptSchema, type ExtractedReceipt } from "./schema";

/**
 * Parse the LLM's text response for one receipt into a validated
 * receipt-level result stamped with the receipt id. Tolerates markdown code
 * fences and stray prose around the JSON object.
 */
export function parseExtractionResponse(text: string, receiptId: string): ExtractedReceipt {
  const jsonText = extractJsonObject(text);
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new Error("AI response did not contain valid JSON");
  }
  const result = ModelReceiptSchema.parse(raw);
  return { ...result, receiptId };
}

function extractJsonObject(text: string): string {
  // Strip markdown fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI response did not contain a JSON object");
  }
  return candidate.slice(start, end + 1);
}
