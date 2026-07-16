import { describe, expect, it } from "vitest";
import { composeDescription, DESCRIPTION_MAX_LENGTH } from "@/lib/ai/compose";
import type { ExtractedReceipt } from "@/lib/ai/schema";

function receipt(over: Partial<ExtractedReceipt>): ExtractedReceipt {
  return {
    receiptId: "r1",
    merchant: "Amazon",
    purchaseDate: "2026-06-04",
    totalAmount: 30,
    refundAmount: 0,
    summary: "rulers, duct tape",
    ...over,
  };
}

describe("composeDescription", () => {
  it("formats merchant, short date and summary", () => {
    expect(composeDescription(receipt({}))).toBe("Amazon 06/04 — rulers, duct tape");
  });

  it("omits the date when the model could not read one", () => {
    expect(composeDescription(receipt({ purchaseDate: null }))).toBe("Amazon — rulers, duct tape");
  });

  it("truncates to the cap without leaving a dangling surrogate", () => {
    // A summary of emoji (each a surrogate pair): a naive slice at an odd
    // boundary would emit a lone high surrogate (renders as �).
    const summary = "🧾".repeat(400);
    const out = composeDescription(receipt({ summary }));
    expect(out.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);
    expect(out.endsWith("…")).toBe(true);
    // No unpaired surrogate anywhere in the result.
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(out).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it("leaves short descriptions untouched", () => {
    const out = composeDescription(receipt({ summary: "a" }));
    expect(out).toBe("Amazon 06/04 — a");
    expect(out.endsWith("…")).toBe(false);
  });
});
