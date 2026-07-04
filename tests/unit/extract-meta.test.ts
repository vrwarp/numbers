import { afterEach, describe, expect, it } from "vitest";
import { extractReceipts, extractReceipt, ExtractionError } from "@/lib/ai/extract";

const receipts = [
  { id: "r1", filePath: "x/r1.jpg", mimeType: "image/jpeg", originalName: "costco.jpg" },
  { id: "r2", filePath: "x/r2.jpg", mimeType: "image/jpeg", originalName: "target-refund.jpg" },
];

describe("per-receipt extraction metadata (for the tuning log)", () => {
  const oldEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...oldEnv };
  });

  it("returns one outcome per receipt with prompt/response metadata in mock mode", async () => {
    process.env.AI_MOCK = "1";
    const outcomes = await extractReceipts(receipts);
    expect(outcomes).toHaveLength(2);
    for (const [i, outcome] of outcomes.entries()) {
      expect(outcome.receipt.id).toBe(receipts[i].id);
      expect(outcome.error).toBeNull();
      // The result is stamped with its own receipt's id.
      expect(outcome.result!.receiptId).toBe(receipts[i].id);
      expect(outcome.result!.merchant).toBeTruthy();
      expect(outcome.meta.model).toBe("mock");
      expect(outcome.meta.prompt).toContain("one receipt document");
      expect(JSON.parse(outcome.meta.receiptsJson)).toEqual([
        { id: receipts[i].id, name: receipts[i].originalName, mimeType: receipts[i].mimeType },
      ]);
      expect(outcome.meta.durationMs).toBeGreaterThanOrEqual(0);
      // The raw response must parse back to the same result (what gets logged).
      expect(JSON.parse(outcome.meta.rawResponse!)).toEqual(outcome.result);
    }
  });

  it("extractReceipt throws an ExtractionError carrying metadata when unconfigured", async () => {
    process.env.AI_MOCK = "0";
    delete process.env.OPENROUTER_API_KEY;
    try {
      await extractReceipt(receipts[0]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractionError);
      const e = err as ExtractionError;
      expect(e.message).toMatch(/OPENROUTER_API_KEY/);
      expect(e.meta.receiptsJson).toContain("r1");
      expect(e.meta.rawResponse).toBeNull();
    }
  });

  it("extractReceipts settles failures as loggable outcomes instead of rejecting", async () => {
    process.env.AI_MOCK = "0";
    delete process.env.OPENROUTER_API_KEY;
    const outcomes = await extractReceipts(receipts);
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.result).toBeNull();
      expect(outcome.error).toMatch(/OPENROUTER_API_KEY/);
      expect(outcome.meta.prompt).toBeTruthy();
      expect(outcome.meta.rawResponse).toBeNull();
    }
  });
});
