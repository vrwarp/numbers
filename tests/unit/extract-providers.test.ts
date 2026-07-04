import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractReceipt,
  extractReceipts,
  ExtractionError,
  type ExtractionEvent,
} from "@/lib/ai/extract";
import { resetRateLimiterForTests } from "@/lib/ai/throttle";

vi.mock("@/lib/storage", () => ({
  readStoredFile: vi.fn(async () => Buffer.from("fake-receipt-bytes")),
}));

const receipt = {
  id: "r1",
  filePath: "x/r1.jpg",
  mimeType: "image/jpeg",
  originalName: "costco.jpg",
};

const receiptJson =
  '{"merchant":"Peets Coffee","purchaseDate":"2026-06-20","totalAmount":4.5,"refundAmount":0,"summary":"coffee"}';

function googleResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AI provider selection (AI_PROVIDER)", () => {
  const oldEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...oldEnv };
    vi.unstubAllGlobals();
    resetRateLimiterForTests();
  });

  it("settles an unknown AI_PROVIDER as a loggable failure, not a rejection", async () => {
    process.env.AI_MOCK = "0";
    process.env.AI_PROVIDER = "gemini";
    const outcomes = await extractReceipts([receipt]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].result).toBeNull();
    expect(outcomes[0].error).toMatch(/Unknown AI_PROVIDER "gemini"/);
    expect(outcomes[0].meta.rawResponse).toBeNull();
  });

  it("requires GEMINI_API_KEY when AI_PROVIDER=google", async () => {
    process.env.AI_MOCK = "0";
    process.env.AI_PROVIDER = "google";
    delete process.env.GEMINI_API_KEY;
    try {
      await extractReceipt(receipt);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractionError);
      const e = err as ExtractionError;
      expect(e.message).toMatch(/GEMINI_API_KEY/);
      expect(e.meta.model).toBe("gemini-3.1-flash-lite");
      expect(e.meta.rawResponse).toBeNull();
    }
  });

  it("calls Google AI Studio generateContent with the receipt inlined", async () => {
    process.env.AI_MOCK = "0";
    process.env.AI_PROVIDER = "google";
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_MODEL = "gemini-test";
    const fetchMock = vi.fn(async () =>
      googleResponse({ candidates: [{ content: { parts: [{ text: receiptJson }] } }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result, meta } = await extractReceipt(receipt);

    expect(result).toEqual({
      merchant: "Peets Coffee",
      purchaseDate: "2026-06-20",
      totalAmount: 4.5,
      refundAmount: 0,
      summary: "coffee",
      receiptId: "r1",
    });
    expect(meta.model).toBe("gemini-test");
    expect(meta.rawResponse).toBe(receiptJson);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent"
    );
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig).toEqual({ temperature: 0.1 });
    expect(body.contents[0].parts[0].text).toContain("one receipt document");
    expect(body.contents[0].parts[1].inline_data).toEqual({
      mime_type: "image/jpeg",
      data: Buffer.from("fake-receipt-bytes").toString("base64"),
    });
  });

  it("surfaces Google API errors with the response body preserved for logging", async () => {
    process.env.AI_MOCK = "0";
    process.env.AI_PROVIDER = "google";
    process.env.GEMINI_API_KEY = "test-key";
    process.env.AI_QUOTA_MAX_RETRIES = "0"; // surface the 429 without retrying
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => googleResponse({ error: { message: "quota exceeded" } }, 429))
    );
    try {
      await extractReceipt(receipt);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractionError);
      const e = err as ExtractionError;
      expect(e.message).toMatch(/Google AI Studio API error 429/);
      expect(e.meta.rawResponse).toContain("quota exceeded");
    }
  });

  it("waits out a quota error, retries, and notifies via onEvent", async () => {
    process.env.AI_MOCK = "0";
    process.env.AI_PROVIDER = "google";
    process.env.GEMINI_API_KEY = "test-key";
    process.env.AI_QUOTA_MAX_RETRIES = "1";
    process.env.AI_QUOTA_COOLDOWN_MS = "0"; // don't actually wait a minute in tests
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 1
        ? googleResponse({ error: { message: "RESOURCE_EXHAUSTED" } }, 429)
        : googleResponse({ candidates: [{ content: { parts: [{ text: receiptJson }] } }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const events: ExtractionEvent[] = [];
    const { result } = await extractReceipt(receipt, (ev) => events.push(ev));

    expect(result.merchant).toBe("Peets Coffee");
    expect(fetchMock).toHaveBeenCalledTimes(2); // failed once, then retried
    const wait = events.find((e) => e.type === "quota-wait");
    expect(wait).toMatchObject({ type: "quota-wait", attempt: 1, maxRetries: 1 });
  });

  it("treats a response without candidate text as an error", async () => {
    process.env.AI_MOCK = "0";
    process.env.AI_PROVIDER = "google";
    process.env.GEMINI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => googleResponse({ candidates: [] })));
    await expect(extractReceipt(receipt)).rejects.toThrow(/empty response/);
  });

  it("still defaults to OpenRouter when AI_PROVIDER is unset", async () => {
    process.env.AI_MOCK = "0";
    delete process.env.AI_PROVIDER;
    process.env.OPENROUTER_API_KEY = "or-key";
    const fetchMock = vi.fn(async () =>
      googleResponse({ choices: [{ message: { content: receiptJson } }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { meta } = await extractReceipt(receipt);
    expect(meta.model).toBe("google/gemini-3.1-flash-lite");
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });
});
