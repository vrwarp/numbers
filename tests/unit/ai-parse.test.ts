import { describe, expect, it } from "vitest";
import { parseExtractionResponse } from "@/lib/ai/parse";
import { mockExtract } from "@/lib/ai/mock";

describe("parseExtractionResponse", () => {
  const item = { description: "Coffee", quantity: 1, amount: 4.5 };

  it("parses a clean JSON array and stamps the receipt id", () => {
    const out = parseExtractionResponse(JSON.stringify([item]), "r1");
    expect(out).toHaveLength(1);
    expect(out[0].description).toBe("Coffee");
    expect(out[0].receiptId).toBe("r1");
  });

  it("parses JSON wrapped in a markdown fence", () => {
    const text = "Here you go:\n```json\n" + JSON.stringify([item]) + "\n```\nDone!";
    expect(parseExtractionResponse(text, "r1")).toHaveLength(1);
  });

  it("parses JSON surrounded by prose", () => {
    const text = "The extracted items are " + JSON.stringify([item]) + " as requested.";
    expect(parseExtractionResponse(text, "r1")).toHaveLength(1);
  });

  it("accepts negative quantities and amounts (refunds)", () => {
    const refund = { ...item, quantity: -2, amount: -27.98 };
    const out = parseExtractionResponse(JSON.stringify([refund]), "r1");
    expect(out[0].amount).toBe(-27.98);
    expect(out[0].quantity).toBe(-2);
  });

  it("overrides any receiptId the model tries to output (hallucination guard)", () => {
    const echoed = { ...item, receiptId: "made-up" };
    const out = parseExtractionResponse(JSON.stringify([echoed]), "r1");
    expect(out[0].receiptId).toBe("r1");
  });

  it("rejects non-JSON, empty arrays, and malformed items", () => {
    expect(() => parseExtractionResponse("sorry, I cannot help", "r1")).toThrow();
    expect(() => parseExtractionResponse("[]", "r1")).toThrow(/no line items/);
    expect(() => parseExtractionResponse('[{"description": 5}]', "r1")).toThrow();
    expect(() => parseExtractionResponse('[{"description":"x","quantity":"one","amount":1}]', "r1")).toThrow();
  });
});

describe("mockExtract", () => {
  const receipt = (id: string, name: string) => ({ id, filePath: "x", mimeType: "image/jpeg", originalName: name });

  it("produces purchase items with a dedicated tax line", () => {
    const out = mockExtract([receipt("a", "costco.jpg")]);
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out.every((it) => it.receiptId === "a")).toBe(true);
    expect(out.some((it) => /tax/i.test(it.description))).toBe(true);
    expect(out.every((it) => it.amount > 0)).toBe(true);
  });

  it("produces negative rows for refund receipts", () => {
    const out = mockExtract([receipt("b", "costco-refund.jpg")]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((it) => it.amount < 0 && it.quantity < 0)).toBe(true);
  });
});
