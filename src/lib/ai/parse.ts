import { ModelResultSchema, type ExtractedItem } from "./schema";

/**
 * Parse the LLM's text response for one receipt into validated items, each
 * stamped with the receipt id. Tolerates markdown code fences and stray prose
 * around the JSON array.
 */
export function parseExtractionResponse(text: string, receiptId: string): ExtractedItem[] {
  const jsonText = extractJsonArray(text);
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new Error("AI response did not contain valid JSON");
  }
  const items = ModelResultSchema.parse(raw);
  if (items.length === 0) throw new Error("AI response contained no line items");
  return items.map((item) => ({ ...item, receiptId }));
}

function extractJsonArray(text: string): string {
  // Strip markdown fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI response did not contain a JSON array");
  }
  return candidate.slice(start, end + 1);
}
