/**
 * All monetary amounts are stored as integer cents. These helpers convert
 * between cents and display/user-input dollar strings.
 */

/** "12.34" | "-12.34" | "$12.34" | 12.34 -> cents. Throws on garbage. */
export function parseDollarsToCents(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error(`Invalid amount: ${input}`);
    return Math.round(input * 100);
  }
  // Chinese IMEs emit full-width digits/punctuation (１２．３４) — normalize
  // them to ASCII before validating instead of rejecting the amount.
  const halfWidth = input
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/．/g, ".")
    .replace(/[－−]/g, "-")
    .replace(/[＄￥，]/g, "");
  const cleaned = halfWidth.replace(/[$,\s]/g, "");
  if (!/^-?\d*(\.\d{0,4})?$/.test(cleaned) || cleaned === "" || cleaned === "-") {
    throw new Error(`Invalid amount: ${input}`);
  }
  return Math.round(parseFloat(cleaned) * 100);
}

/** cents -> "12.34" (no currency symbol). */
export function centsToDollarString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** cents -> "$12.34" / "-$12.34" for display. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${centsToDollarString(Math.abs(cents))}`;
}

export interface SubtotalItem {
  amountCents: number;
  isExcluded: boolean;
}

/** Sum of non-excluded line amounts. */
export function subtotalCents(items: SubtotalItem[]): number {
  return items.reduce((sum, it) => (it.isExcluded ? sum : sum + it.amountCents), 0);
}
