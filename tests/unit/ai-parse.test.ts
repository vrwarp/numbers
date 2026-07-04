import { describe, expect, it } from "vitest";
import { parseExtractionResponse } from "@/lib/ai/parse";
import { mockExtract } from "@/lib/ai/mock";
import { composeDescription } from "@/lib/ai/compose";

describe("parseExtractionResponse", () => {
  const result = {
    merchant: "Amazon",
    purchaseDate: "2026-06-04",
    totalAmount: 36.31,
    refundAmount: 5.36,
    summary: "Paper plates (refunded), rulers, duct tape",
  };

  it("parses a clean JSON object and stamps the receipt id", () => {
    const out = parseExtractionResponse(JSON.stringify(result), "r1");
    expect(out.merchant).toBe("Amazon");
    expect(out.totalAmount).toBe(36.31);
    expect(out.receiptId).toBe("r1");
  });

  it("parses JSON wrapped in a markdown fence", () => {
    const text = "Here you go:\n```json\n" + JSON.stringify(result) + "\n```\nDone!";
    expect(parseExtractionResponse(text, "r1").merchant).toBe("Amazon");
  });

  it("parses JSON surrounded by prose", () => {
    const text = "The extracted receipt is " + JSON.stringify(result) + " as requested.";
    expect(parseExtractionResponse(text, "r1").refundAmount).toBe(5.36);
  });

  it("defaults refundAmount to 0 when the model omits it", () => {
    const { refundAmount: _omitted, ...noRefund } = result;
    expect(parseExtractionResponse(JSON.stringify(noRefund), "r1").refundAmount).toBe(0);
  });

  it("accepts a null purchaseDate (unreadable receipt date)", () => {
    const out = parseExtractionResponse(JSON.stringify({ ...result, purchaseDate: null }), "r1");
    expect(out.purchaseDate).toBeNull();
  });

  it("overrides any receiptId the model tries to output (hallucination guard)", () => {
    const echoed = { ...result, receiptId: "made-up" };
    expect(parseExtractionResponse(JSON.stringify(echoed), "r1").receiptId).toBe("r1");
  });

  it("rejects non-JSON, malformed dates, negative refunds, and missing fields", () => {
    expect(() => parseExtractionResponse("sorry, I cannot help", "r1")).toThrow();
    expect(() => parseExtractionResponse("{}", "r1")).toThrow();
    expect(() =>
      parseExtractionResponse(JSON.stringify({ ...result, purchaseDate: "06/04/2026" }), "r1")
    ).toThrow();
    expect(() =>
      parseExtractionResponse(JSON.stringify({ ...result, refundAmount: -5.36 }), "r1")
    ).toThrow();
    expect(() =>
      parseExtractionResponse(JSON.stringify({ ...result, totalAmount: "36.31" }), "r1")
    ).toThrow();
    expect(() => parseExtractionResponse(JSON.stringify({ ...result, summary: "" }), "r1")).toThrow();
  });
});

describe("mockExtract", () => {
  const receipt = (id: string, name: string) => ({ id, filePath: "x", mimeType: "image/jpeg", originalName: name });

  it("produces the deterministic purchase fixture", () => {
    const out = mockExtract(receipt("a", "costco.jpg"));
    expect(out.receiptId).toBe("a");
    expect(out.merchant).toBe("Costco Wholesale");
    expect(out.totalAmount).toBe(102.1);
    expect(out.refundAmount).toBe(0);
  });

  it("produces a partial refund for 'refund' file names (net 30.95)", () => {
    const out = mockExtract(receipt("b", "amazon-refund.jpg"));
    expect(out.totalAmount).toBe(36.31);
    expect(out.refundAmount).toBe(5.36);
  });

  it("produces a pure return for 'return' file names (net negative)", () => {
    const out = mockExtract(receipt("c", "costco-return.jpg"));
    expect(out.totalAmount).toBe(0);
    expect(out.refundAmount).toBe(27.98);
  });
});

describe("composeDescription", () => {
  it("joins merchant, short date and summary", () => {
    expect(
      composeDescription({
        receiptId: "r1",
        merchant: "Amazon",
        purchaseDate: "2026-06-04",
        totalAmount: 36.31,
        refundAmount: 5.36,
        summary: "rulers, duct tape",
      })
    ).toBe("Amazon 06/04 — rulers, duct tape");
  });

  it("omits the date part when the model could not read one", () => {
    expect(
      composeDescription({
        receiptId: "r1",
        merchant: "Costco Wholesale",
        purchaseDate: null,
        totalAmount: 102.1,
        refundAmount: 0,
        summary: "paper towels",
      })
    ).toBe("Costco Wholesale — paper towels");
  });

  it("truncates to the 300-char description cap", () => {
    const out = composeDescription({
      receiptId: "r1",
      merchant: "Amazon",
      purchaseDate: "2026-06-04",
      totalAmount: 1,
      refundAmount: 0,
      summary: "x".repeat(400),
    });
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith("…")).toBe(true);
  });
});
