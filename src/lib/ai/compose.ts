import type { ExtractedReceipt } from "./schema";

// Matches the line-items PATCH route's description cap.
export const DESCRIPTION_MAX_LENGTH = 300;

/** The three fields composeDescription reads; the rest of an ExtractedReceipt
 *  may ride along, so both a fresh extraction and a Receipt row's stored
 *  annotation fit. */
export type ComposableReceipt = Partial<ExtractedReceipt> &
  Pick<ExtractedReceipt, "merchant" | "purchaseDate" | "summary">;

/**
 * Compose the initial (editable) line-item description from a receipt-level
 * extraction: "Amazon 06/04 — rulers, duct tape, clothespins". The date part
 * is omitted when the model could not read one.
 */
export function composeDescription(result: ComposableReceipt): string {
  const date = formatShortDate(result.purchaseDate);
  const composed = `${result.merchant}${date ? ` ${date}` : ""} — ${result.summary}`;
  if (composed.length <= DESCRIPTION_MAX_LENGTH) return composed;
  // Stay within the code-unit cap (the route/DB constraint counts code units),
  // but never leave a dangling high surrogate: a raw .slice can cut a surrogate
  // pair (emoji / rare CJK) and store a lone surrogate that renders as �.
  let cut = composed.slice(0, DESCRIPTION_MAX_LENGTH - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + "…";
}

/** "2026-06-04" → "06/04"; anything unparsable → "". */
function formatShortDate(purchaseDate: string | null): string {
  if (!purchaseDate) return "";
  const m = purchaseDate.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}/${m[2]}` : "";
}
