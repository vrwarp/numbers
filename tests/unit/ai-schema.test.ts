import { describe, expect, it } from "vitest";
import { ModelReceiptSchema } from "@/lib/ai/schema";

const base = {
  merchant: "Costco",
  purchaseDate: "2026-06-21",
  totalAmount: 102.1,
  refundAmount: 0,
  summary: "paper towels",
};

/**
 * The extraction schema is the boundary between untrusted LLM output and the
 * integer-cents money core. A defect here that lets an absurd number or an
 * impossible date through 500s the batch (Int overflow) or prints "99/99" on
 * the official form, instead of degrading to a manual-entry row.
 */
describe("ModelReceiptSchema", () => {
  it("accepts a well-formed receipt and defaults refund to 0", () => {
    const parsed = ModelReceiptSchema.parse({ ...base, refundAmount: undefined });
    expect(parsed.refundAmount).toBe(0);
  });

  it("rejects impossible calendar dates", () => {
    for (const d of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2026-01-32"]) {
      expect(ModelReceiptSchema.safeParse({ ...base, purchaseDate: d }).success, d).toBe(false);
    }
  });

  it("accepts a real leap day but rejects a non-leap-year Feb 29", () => {
    expect(ModelReceiptSchema.safeParse({ ...base, purchaseDate: "2024-02-29" }).success).toBe(true);
    expect(ModelReceiptSchema.safeParse({ ...base, purchaseDate: "2026-02-29" }).success).toBe(false);
  });

  it("allows a null date (unreadable) but not a malformed string", () => {
    expect(ModelReceiptSchema.safeParse({ ...base, purchaseDate: null }).success).toBe(true);
    expect(ModelReceiptSchema.safeParse({ ...base, purchaseDate: "6/21/26" }).success).toBe(false);
  });

  it("rejects absurd magnitudes that would overflow integer-cent math", () => {
    expect(ModelReceiptSchema.safeParse({ ...base, totalAmount: 1e12 }).success).toBe(false);
    expect(ModelReceiptSchema.safeParse({ ...base, totalAmount: -1e12 }).success).toBe(false);
    expect(ModelReceiptSchema.safeParse({ ...base, refundAmount: 1e12 }).success).toBe(false);
  });

  it("rejects negative refunds, NaN, and non-numeric amounts", () => {
    expect(ModelReceiptSchema.safeParse({ ...base, refundAmount: -1 }).success).toBe(false);
    expect(ModelReceiptSchema.safeParse({ ...base, totalAmount: NaN }).success).toBe(false);
    expect(ModelReceiptSchema.safeParse({ ...base, totalAmount: "12.34" }).success).toBe(false);
  });

  it("rejects blank/whitespace merchant and summary and trims them", () => {
    expect(ModelReceiptSchema.safeParse({ ...base, merchant: "   " }).success).toBe(false);
    expect(ModelReceiptSchema.safeParse({ ...base, summary: "" }).success).toBe(false);
    expect(ModelReceiptSchema.parse({ ...base, merchant: "  Costco  " }).merchant).toBe("Costco");
  });

  it("rejects an over-long summary", () => {
    expect(ModelReceiptSchema.safeParse({ ...base, summary: "x".repeat(201) }).success).toBe(false);
  });
});
