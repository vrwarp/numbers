import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractLineItems, ExtractionError } from "@/lib/ai/extract";

const receipts = [
  { id: "r1", filePath: "x/r1.jpg", mimeType: "image/jpeg", originalName: "costco.jpg" },
];

describe("extractLineItems metadata (for the tuning log)", () => {
  const oldEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...oldEnv };
  });

  it("returns items plus prompt/response metadata in mock mode", async () => {
    process.env.AI_MOCK = "1";
    const { items, meta } = await extractLineItems(receipts);
    expect(items.length).toBeGreaterThan(0);
    expect(meta.model).toBe("mock");
    expect(meta.prompt).toContain("RECEIPT ID");
    expect(meta.prompt).toContain("r1");
    expect(meta.rawResponse).toBeTruthy();
    expect(JSON.parse(meta.receiptsJson)).toEqual([
      { id: "r1", name: "costco.jpg", mimeType: "image/jpeg" },
    ]);
    expect(meta.durationMs).toBeGreaterThanOrEqual(0);
    // The raw response must parse back to the same items (what gets logged).
    expect(JSON.parse(meta.rawResponse!)).toEqual(items);
  });

  it("throws an ExtractionError carrying metadata when unconfigured", async () => {
    process.env.AI_MOCK = "0";
    delete process.env.GLM_API_KEY;
    try {
      await extractLineItems(receipts);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractionError);
      const e = err as ExtractionError;
      expect(e.message).toMatch(/GLM_API_KEY/);
      expect(e.meta.prompt).toContain("r1");
      expect(e.meta.rawResponse).toBeNull();
    }
  });
});
