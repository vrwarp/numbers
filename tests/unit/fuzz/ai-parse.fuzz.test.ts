import { describe, expect } from "vitest";
import { parseExtractionResponse, extractJsonObject } from "@/lib/ai/parse";
import { ModelReceiptSchema } from "@/lib/ai/schema";
import { composeDescription, DESCRIPTION_MAX_LENGTH } from "@/lib/ai/compose";
import { parseDollarsToCents } from "@/lib/money";
import { fuzz, Rng } from "./prng";

function validPayload(rng: Rng) {
  const day = rng.int(1, 28);
  return {
    merchant: `M-${rng.asciiString(10).replace(/\s/g, "") || "x"}`,
    purchaseDate: rng.bool(0.8)
      ? `${rng.int(2020, 2030)}-${String(rng.int(1, 12)).padStart(2, "0")}-${String(day).padStart(2, "0")}`
      : null,
    totalAmount: rng.int(-100000, 1000000) / 100,
    refundAmount: rng.int(0, 100000) / 100,
    summary: `S-${rng.asciiString(30).replace(/\s/g, "") || "x"}`,
  };
}

/** Wrap a JSON payload the ways real LLMs do: fences, prose, whitespace. */
function decorate(rng: Rng, json: string): string {
  const prose = () => rng.pick(["Here is the extraction:", "Sure!", "以下是结果：", "", "Note: totals verified."]);
  switch (rng.int(0, 4)) {
    case 0:
      return json;
    case 1:
      return "```json\n" + json + "\n```";
    case 2:
      return "```\n" + json + "\n```";
    case 3:
      return `${prose()}\n${json}\n${prose()}`;
    default:
      return `${prose()} ${"```json"}\n${json}\n${"```"} ${prose()}`;
  }
}

/**
 * The LLM boundary is the least trustworthy input in the app. These
 * properties pin: valid payloads always survive any decoration the model
 * wraps them in, and no malformed response ever produces a *silently wrong*
 * result — it's either valid data or a thrown error.
 */
describe("ai response parsing fuzz", () => {
  fuzz("valid JSON survives fences/prose decoration untouched", { iters: 400 }, (rng) => {
    const payload = validPayload(rng);
    const parsed = parseExtractionResponse(decorate(rng, JSON.stringify(payload)), "r-1");
    expect(parsed.merchant).toBe(payload.merchant);
    expect(parsed.purchaseDate).toBe(payload.purchaseDate);
    expect(parsed.totalAmount).toBe(payload.totalAmount);
    expect(parsed.refundAmount).toBe(payload.refundAmount);
    expect(parsed.receiptId).toBe("r-1");
  });

  fuzz("random garbage always throws, never returns partial data", { iters: 500 }, (rng) => {
    const s = rng.unicodeString(60);
    // Only run the garbage path: skip strings that happen to contain a valid object.
    let ok = false;
    let out: unknown;
    try {
      out = parseExtractionResponse(s, "r-1");
      ok = true;
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
    if (ok) {
      // If something parsed, it must be a fully-validated receipt.
      expect(ModelReceiptSchema.safeParse(out).success).toBe(true);
    }
  });

  fuzz("schema rejects impossible calendar dates", { iters: 300 }, (rng) => {
    const payload = validPayload(rng);
    const bad = rng.pick([
      `${rng.int(2020, 2030)}-02-30`,
      `${rng.int(2020, 2030)}-13-01`,
      `${rng.int(2020, 2030)}-00-10`,
      `${rng.int(2020, 2030)}-04-31`,
      `${rng.int(2020, 2030)}-01-00`,
      `${rng.int(2020, 2030)}-01-32`,
    ]);
    expect(() =>
      parseExtractionResponse(JSON.stringify({ ...payload, purchaseDate: bad }), "r-1")
    ).toThrow();
  });

  fuzz("leap-day validity follows the actual calendar", { iters: 200 }, (rng) => {
    const year = rng.int(1990, 2100);
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const payload = { ...validPayload(rng), purchaseDate: `${year}-02-29` };
    const attempt = () => parseExtractionResponse(JSON.stringify(payload), "r-1");
    if (isLeap) expect(attempt().purchaseDate).toBe(`${year}-02-29`);
    else expect(attempt).toThrow();
  });

  fuzz("schema rejects absurd magnitudes, NaN and negative refunds", { iters: 300 }, (rng) => {
    const payload = validPayload(rng);
    const corrupted = rng.pick([
      { ...payload, totalAmount: rng.pick([1e12, -1e12, Number.MAX_VALUE]) },
      { ...payload, refundAmount: -rng.int(1, 1000) / 100 },
      { ...payload, refundAmount: 1e12 },
      { ...payload, merchant: rng.pick(["", "   ", "\t\n"]) },
      { ...payload, summary: "" },
      { ...payload, summary: "s".repeat(201) },
      { ...payload, totalAmount: "12.34" as unknown as number },
    ]);
    expect(() => parseExtractionResponse(JSON.stringify(corrupted), "r-1")).toThrow();
  });

  fuzz("any amount the schema accepts converts safely to integer cents", { iters: 400 }, (rng) => {
    const payload = validPayload(rng);
    const parsed = ModelReceiptSchema.parse(payload);
    const total = parseDollarsToCents(parsed.totalAmount);
    const refund = parseDollarsToCents(parsed.refundAmount);
    expect(Number.isSafeInteger(total)).toBe(true);
    expect(Number.isSafeInteger(refund)).toBe(true);
    expect(Number.isSafeInteger(total - refund)).toBe(true);
  });

  fuzz("extractJsonObject finds the object across arbitrary wrapping", { iters: 300 }, (rng) => {
    const inner = JSON.stringify({ k: rng.asciiString(8).replace(/[{}"\\]/g, "") });
    const before = rng.unicodeString(20).replace(/[{}`]/g, "");
    const after = rng.unicodeString(20).replace(/[{}`]/g, "");
    expect(extractJsonObject(`${before}${inner}${after}`)).toBe(inner);
  });

  fuzz("text without an object always throws", { iters: 200 }, (rng) => {
    const s = rng.unicodeString(40).replace(/[{}]/g, "");
    expect(() => extractJsonObject(s)).toThrow();
  });

  fuzz("composed descriptions never exceed the PATCH route's cap", { iters: 300 }, (rng) => {
    const parsed = ModelReceiptSchema.parse({
      ...validPayload(rng),
      merchant: rng.unicodeString(rng.int(1, 150)).trim() || "M",
      summary: rng.unicodeString(rng.int(1, 200)).trim().slice(0, 200) || "S",
    });
    const desc = composeDescription({ ...parsed, receiptId: "r-1" });
    expect(desc.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);
    expect(desc).toContain("—");
  });
});
