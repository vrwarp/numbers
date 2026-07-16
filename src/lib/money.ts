/**
 * All monetary amounts are stored as integer cents. These helpers convert
 * between cents and display/user-input dollar strings.
 */

/** Largest magnitude we accept, in cents — beyond this integer-cent math (and
 *  any real reimbursement) stops making sense. */
export const MAX_AMOUNT_CENTS = 100_000_000_000; // $1,000,000,000.00

/** "12.34" | "-12.34" | "$12.34" | 12.34 -> cents. Throws on garbage. */
export function parseDollarsToCents(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error(`Invalid amount: ${input}`);
    const cents = Math.round(input * 100);
    if (Math.abs(cents) > MAX_AMOUNT_CENTS) throw new Error(`Invalid amount: ${input}`);
    // Math.round(-0.4) is -0; normalize so callers never see negative zero.
    return cents === 0 ? 0 : cents;
  }
  // Chinese IMEs emit full-width digits/punctuation (１２．３４) — normalize
  // them to ASCII before validating instead of rejecting the amount.
  const halfWidth = input
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/．/g, ".")
    .replace(/[－−]/g, "-")
    .replace(/[＄￥，]/g, "");
  const cleaned = halfWidth.replace(/[$,\s]/g, "");
  // Require at least one digit somewhere: "", "-", ".", "-." are all garbage
  // (parseFloat would turn the dot-only forms into NaN, not an error).
  const m = cleaned.match(/^(-?)(\d*)(?:\.(\d{0,4}))?$/);
  if (!m || (m[2] === "" && !m[3])) {
    throw new Error(`Invalid amount: ${input}`);
  }
  // Integer decimal math instead of parseFloat: 1.005 must round to 101
  // cents, but parseFloat("1.005")*100 is 100.4999… and rounds to 100.
  const [, sign, intPart, fracPart = ""] = m;
  const whole = intPart === "" ? 0 : parseInt(intPart, 10);
  const fracCents = Math.round(parseInt(fracPart.padEnd(4, "0") || "0", 10) / 100);
  const cents = whole * 100 + fracCents;
  if (cents > MAX_AMOUNT_CENTS) throw new Error(`Invalid amount: ${input}`);
  return sign === "-" && cents !== 0 ? -cents : cents;
}

/** cents -> "12.34" (no currency symbol). */
export function centsToDollarString(cents: number): string {
  if (!Number.isFinite(cents)) throw new Error(`Invalid cents: ${cents}`);
  // Amounts are integer cents by invariant; round defensively so a stray
  // float never renders as "1.0.5"-style garbage.
  const whole = Math.round(cents);
  const sign = whole < 0 ? "-" : "";
  const abs = Math.abs(whole);
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
