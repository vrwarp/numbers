import { describe, expect } from "vitest";
import {
  parseDollarsToCents,
  centsToDollarString,
  formatCents,
  subtotalCents,
  MAX_AMOUNT_CENTS,
} from "@/lib/money";
import { fuzz, Rng } from "./prng";

/**
 * Property-based checks over the money helpers. Money is the app's most
 * dangerous datatype (invariant 1: integer cents everywhere), so these
 * assert round-trip identities and integer-only outputs across the whole
 * input space rather than a handful of examples.
 */
describe("money fuzz", () => {
  fuzz("cents -> dollar string -> cents round-trips exactly", { iters: 500 }, (rng) => {
    const cents = rng.cents();
    const s = centsToDollarString(cents);
    expect(parseDollarsToCents(s)).toBe(cents);
  });

  fuzz("parse always returns a safe integer or throws", { iters: 500 }, (rng) => {
    // Adversarial numeric-ish strings assembled from money-shaped fragments.
    const fragments = ["$", "-", ".", ",", " ", "0", "1", "9", "．", "－", "＄", "，", "１", "e", "+"];
    let s = "";
    const len = rng.int(0, 12);
    for (let i = 0; i < len; i++) s += rng.pick(fragments);
    let out: number | undefined;
    try {
      out = parseDollarsToCents(s);
    } catch {
      return; // throwing on garbage is the contract
    }
    // If it parsed, it must be a clean integer — never NaN/Infinity/float.
    expect(Number.isSafeInteger(out)).toBe(true);
    expect(Object.is(out, -0)).toBe(false);
  });

  fuzz("string parsing matches integer decimal math", { iters: 500 }, (rng) => {
    const negative = rng.bool(0.3);
    const whole = rng.int(0, 1_000_000);
    const fracDigits = rng.int(0, 4);
    const frac = rng.array(fracDigits, (r) => r.int(0, 9)).join("");
    const s = `${negative ? "-" : ""}${whole}${fracDigits > 0 ? "." + frac : ""}`;
    const expectedAbs = whole * 100 + Math.round(Number(frac.padEnd(4, "0") || "0") / 100);
    const expected = negative && expectedAbs !== 0 ? -expectedAbs : expectedAbs;
    expect(parseDollarsToCents(s)).toBe(expected);
  });

  fuzz("full-width digits parse identically to ASCII", { iters: 300 }, (rng) => {
    const cents = Math.abs(rng.cents());
    const ascii = centsToDollarString(cents);
    const fullWidth = ascii
      .replace(/[0-9]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0))
      .replace(".", "．");
    expect(parseDollarsToCents(fullWidth)).toBe(cents);
  });

  fuzz("currency symbols, commas and spaces never change the value", { iters: 300 }, (rng) => {
    const cents = Math.abs(rng.cents());
    const base = centsToDollarString(cents);
    // Sprinkle legal decorations: $ prefix, thousands commas, stray spaces.
    let decorated = rng.bool() ? `$${base}` : base;
    const [int, frac] = decorated.split(".");
    if (rng.bool() && int.replace("$", "").length > 3) {
      const digits = int.replace("$", "");
      const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      decorated = `${int.startsWith("$") ? "$" : ""}${grouped}.${frac}`;
    }
    if (rng.bool()) decorated = ` ${decorated} `;
    expect(parseDollarsToCents(decorated)).toBe(cents);
  });

  fuzz("number input agrees with string input for 2-decimal values", { iters: 300 }, (rng) => {
    const cents = rng.cents();
    const s = centsToDollarString(cents);
    expect(parseDollarsToCents(Number(s))).toBe(cents);
  });

  fuzz("formatCents output always re-parses to the same value", { iters: 300 }, (rng) => {
    const cents = rng.cents();
    const formatted = formatCents(cents);
    expect(formatted).toMatch(/^-?\$\d+\.\d{2}$/);
    expect(parseDollarsToCents(formatted.replace("$", ""))).toBe(cents);
  });

  fuzz("random unicode garbage either throws or yields an integer", { iters: 400 }, (rng) => {
    const s = rng.unicodeString(16);
    try {
      const out = parseDollarsToCents(s);
      expect(Number.isSafeInteger(out)).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });

  fuzz("subtotal equals the sum of non-excluded rows and stays integer", { iters: 400 }, (rng) => {
    const items = rng.array(rng.int(0, 40), (r) => ({
      amountCents: r.cents(),
      isExcluded: r.bool(0.3),
    }));
    const expected = items.filter((i) => !i.isExcluded).reduce((a, b) => a + b.amountCents, 0);
    const got = subtotalCents(items);
    expect(got).toBe(expected);
    expect(Number.isSafeInteger(got)).toBe(true);
  });

  fuzz("subtotal is permutation-invariant", { iters: 200 }, (rng) => {
    const items = rng.array(rng.int(0, 30), (r) => ({
      amountCents: r.cents(),
      isExcluded: r.bool(0.3),
    }));
    expect(subtotalCents(rng.shuffle(items))).toBe(subtotalCents(items));
  });

  fuzz("values beyond MAX_AMOUNT_CENTS are rejected", { iters: 100 }, (rng) => {
    const over = MAX_AMOUNT_CENTS + rng.int(1, 1_000_000_000);
    expect(() => parseDollarsToCents(over / 100)).toThrow();
    expect(() => parseDollarsToCents(`${Math.floor(over / 100)}.${String(over % 100).padStart(2, "0")}`)).toThrow();
  });
});
