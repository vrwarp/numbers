import { describe, expect, it } from "vitest";
import { parseDollarsToCents, centsToDollarString, formatCents, subtotalCents } from "@/lib/money";

describe("parseDollarsToCents", () => {
  it("parses plain dollar strings", () => {
    expect(parseDollarsToCents("12.34")).toBe(1234);
    expect(parseDollarsToCents("0.5")).toBe(50);
    expect(parseDollarsToCents("100")).toBe(10000);
  });

  it("parses negative amounts (refunds)", () => {
    expect(parseDollarsToCents("-27.98")).toBe(-2798);
    expect(parseDollarsToCents(-27.98)).toBe(-2798);
  });

  it("tolerates currency symbols, commas and whitespace", () => {
    expect(parseDollarsToCents("$1,234.56")).toBe(123456);
    expect(parseDollarsToCents(" $ 12.00 ")).toBe(1200);
  });

  it("rounds float input to whole cents", () => {
    expect(parseDollarsToCents(0.1 + 0.2)).toBe(30);
    expect(parseDollarsToCents(19.999)).toBe(2000);
  });

  it("normalizes full-width digits and punctuation from Chinese IMEs", () => {
    expect(parseDollarsToCents("１２．３４")).toBe(1234);
    expect(parseDollarsToCents("－２７．９８")).toBe(-2798);
    expect(parseDollarsToCents("＄１，２３４.５６")).toBe(123456);
    expect(parseDollarsToCents("−5.00")).toBe(-500); // U+2212 minus sign
  });

  it("rejects garbage", () => {
    expect(() => parseDollarsToCents("abc")).toThrow();
    expect(() => parseDollarsToCents("")).toThrow();
    expect(() => parseDollarsToCents("-")).toThrow();
    expect(() => parseDollarsToCents("1.2.3")).toThrow();
    expect(() => parseDollarsToCents(NaN)).toThrow();
    expect(() => parseDollarsToCents(Infinity)).toThrow();
  });
});

describe("centsToDollarString / formatCents", () => {
  it("formats positive and negative cents", () => {
    expect(centsToDollarString(1234)).toBe("12.34");
    expect(centsToDollarString(-1234)).toBe("-12.34");
    expect(centsToDollarString(5)).toBe("0.05");
    expect(centsToDollarString(0)).toBe("0.00");
    expect(formatCents(1234)).toBe("$12.34");
    expect(formatCents(-2798)).toBe("-$27.98");
  });

  it("round-trips with parseDollarsToCents", () => {
    for (const cents of [0, 1, 99, 100, 12345, -1, -12345]) {
      expect(parseDollarsToCents(centsToDollarString(cents))).toBe(cents);
    }
  });
});

describe("subtotalCents", () => {
  it("sums non-excluded items only", () => {
    const items = [
      { amountCents: 1000, isExcluded: false },
      { amountCents: 500, isExcluded: true },
      { amountCents: -300, isExcluded: false },
    ];
    expect(subtotalCents(items)).toBe(700);
  });

  it("returns 0 for empty lists", () => {
    expect(subtotalCents([])).toBe(0);
  });
});
