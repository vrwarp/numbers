import { describe, expect, it } from "vitest";
import { parseExtractionResponse } from "@/lib/ai/parse";
import { mockExtract } from "@/lib/ai/mock";

const IDS = ["r1", "r2"];

describe("parseExtractionResponse", () => {
  const item = { receiptId: "r1", description: "Coffee", quantity: 1, amount: 4.5, suggestedMinistry: "Worship" };

  it("parses a clean JSON array", () => {
    const out = parseExtractionResponse(JSON.stringify([item]), IDS);
    expect(out).toHaveLength(1);
    expect(out[0].description).toBe("Coffee");
  });

  it("parses JSON wrapped in a markdown fence", () => {
    const text = "Here you go:\n```json\n" + JSON.stringify([item]) + "\n```\nDone!";
    expect(parseExtractionResponse(text, IDS)).toHaveLength(1);
  });

  it("parses JSON surrounded by prose", () => {
    const text = "The extracted items are " + JSON.stringify([item]) + " as requested.";
    expect(parseExtractionResponse(text, IDS)).toHaveLength(1);
  });

  it("accepts negative quantities and amounts (refunds)", () => {
    const refund = { ...item, quantity: -2, amount: -27.98 };
    const out = parseExtractionResponse(JSON.stringify([refund]), IDS);
    expect(out[0].amount).toBe(-27.98);
    expect(out[0].quantity).toBe(-2);
  });

  it("defaults a missing suggestedMinistry", () => {
    const noMinistry = { receiptId: "r1", description: "Tape", quantity: 1, amount: 3 };
    expect(parseExtractionResponse(JSON.stringify([noMinistry]), IDS)[0].suggestedMinistry).toBe("");
  });

  it("rejects unknown receipt ids (hallucination guard)", () => {
    const bad = { ...item, receiptId: "made-up" };
    expect(() => parseExtractionResponse(JSON.stringify([bad]), IDS)).toThrow(/unknown receipt/);
  });

  it("rejects non-JSON, empty arrays, and malformed items", () => {
    expect(() => parseExtractionResponse("sorry, I cannot help", IDS)).toThrow();
    expect(() => parseExtractionResponse("[]", IDS)).toThrow(/no line items/);
    expect(() => parseExtractionResponse('[{"description": 5}]', IDS)).toThrow();
    expect(() => parseExtractionResponse('[{"receiptId":"r1","description":"x","quantity":"one","amount":1}]', IDS)).toThrow();
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

  it("handles batches, attributing items to the right receipt", () => {
    const out = mockExtract([receipt("a", "one.jpg"), receipt("b", "two-refund.jpg")]);
    expect(out.filter((it) => it.receiptId === "a").every((it) => it.amount > 0)).toBe(true);
    expect(out.filter((it) => it.receiptId === "b").every((it) => it.amount < 0)).toBe(true);
  });
});
