import type { ExtractedReceipt } from "./schema";

// Matches the line-items PATCH route's description cap.
export const DESCRIPTION_MAX_LENGTH = 300;

/**
 * Compose the initial (editable) line-item description from a receipt-level
 * extraction: "Amazon 06/04 — rulers, duct tape, clothespins". The date part
 * is omitted when the model could not read one.
 */
export function composeDescription(result: ExtractedReceipt): string {
  const date = formatShortDate(result.purchaseDate);
  const composed = `${result.merchant}${date ? ` ${date}` : ""} — ${result.summary}`;
  return composed.length > DESCRIPTION_MAX_LENGTH
    ? composed.slice(0, DESCRIPTION_MAX_LENGTH - 1) + "…"
    : composed;
}

/** "2026-06-04" → "06/04"; anything unparsable → "". */
function formatShortDate(purchaseDate: string | null): string {
  if (!purchaseDate) return "";
  const m = purchaseDate.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}/${m[2]}` : "";
}
