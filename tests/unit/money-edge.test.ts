import { describe, expect, it } from "vitest";
import {
  parseDollarsToCents,
  centsToDollarString,
  formatCents,
  MAX_AMOUNT_CENTS,
} from "@/lib/money";

/**
 * Regression tests for the specific money-parsing defects fixed alongside
 * these tests. Money is invariant #1 (integer cents everywhere); an AI edit
 * that reintroduces float math or a NaN escape should turn one of these red.
 */
describe("parseDollarsToCents — garbage that used to slip through", () => {
  it("throws on dot-only and sign-only inputs instead of returning NaN", () => {
    // The old regex accepted "." (\\d* matches empty, \\.\\d{0,4} matches bare
    // dot) and parseFloat(".") → NaN silently escaped the 'throws on garbage'
    // contract.
    for (const bad of [".", "-.", "$.", "．", "-", "$", "  .  ", "+", "e", "1e3"]) {
      expect(() => parseDollarsToCents(bad), bad).toThrow();
    }
  });

  it("rounds half-cents by decimal value, not float representation", () => {
    // parseFloat("1.005")*100 is 100.4999… → Math.round gives 100 (wrong).
    expect(parseDollarsToCents("1.005")).toBe(101);
    expect(parseDollarsToCents("0.285")).toBe(29);
    expect(parseDollarsToCents("2.675")).toBe(268);
    expect(parseDollarsToCents("8.115")).toBe(812);
  });

  it("never emits negative zero", () => {
    expect(Object.is(parseDollarsToCents("-0.00"), -0)).toBe(false);
    expect(Object.is(parseDollarsToCents(-0.001), -0)).toBe(false);
    expect(parseDollarsToCents("-0.00")).toBe(0);
  });

  it("rejects magnitudes beyond the safe ceiling", () => {
    const overDollars = MAX_AMOUNT_CENTS / 100 + 1;
    expect(() => parseDollarsToCents(overDollars)).toThrow();
    expect(() => parseDollarsToCents(`${overDollars}`)).toThrow();
    // The ceiling itself is accepted.
    expect(parseDollarsToCents(MAX_AMOUNT_CENTS / 100)).toBe(MAX_AMOUNT_CENTS);
  });

  it("still accepts the shapes the app relies on", () => {
    expect(parseDollarsToCents("12.34")).toBe(1234);
    expect(parseDollarsToCents(".5")).toBe(50); // leading-dot with a digit is fine
    expect(parseDollarsToCents("5.")).toBe(500); // trailing dot with a digit is fine
    expect(parseDollarsToCents("$1,234.56")).toBe(123456);
    expect(parseDollarsToCents("１２．３４")).toBe(1234);
  });
});

describe("centsToDollarString — defensive rounding", () => {
  it("throws on non-finite cents rather than emitting garbage", () => {
    expect(() => centsToDollarString(NaN)).toThrow();
    expect(() => centsToDollarString(Infinity)).toThrow();
  });

  it("rounds a stray fractional cent to a clean 2-decimal string", () => {
    expect(centsToDollarString(1234.4)).toBe("12.34");
    expect(formatCents(-2798)).toBe("-$27.98");
  });
});
