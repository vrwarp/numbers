import { describe, expect, it } from "vitest";
import {
  buildClaimComposite,
  claimFingerprint,
  receiptFingerprint,
  receiptPromptText,
  receiptYear,
  claimYear,
  COMPOSITE_BYTE_BUDGET,
} from "@/lib/embeddings/content";
import {
  normalizeQuery,
  queryTerms,
  escapeLike,
  parseQueryMoneyCents,
} from "@/lib/embeddings/normalize";
import { mockEmbed, mockTokens } from "@/lib/embeddings/mock";

const cfgA = { model: "mock-model-a", dim: 256 };
const cfgB = { model: "mock-model-b", dim: 256 };
const dot = (a: Float32Array, b: Float32Array) =>
  a.reduce((s, x, i) => s + x * b[i], 0);

function claim(over: Partial<Parameters<typeof buildClaimComposite>[0]> = {}) {
  return {
    ownerName: "Grace Lee",
    claimDescription: "Youth retreat supplies",
    lineItems: [
      { description: "Costco 06/21 — folding tables", amountCents: 10210, ministry: "210 Youth", event: "Retreat", isExcluded: false },
      { description: "Amazon 06/04 — paper plates", amountCents: 3095, ministry: "210 Youth", event: "", isExcluded: false },
      { description: "Personal snacks", amountCents: 500, ministry: "", event: "", isExcluded: true },
    ],
    merchants: ["Costco Wholesale", "Amazon"],
    totalCents: 13305,
    createdAt: new Date("2026-06-22T10:00:00Z"),
    submittedAt: null,
    ...over,
  };
}

describe("claim composite (SEARCH_DESIGN §5.1)", () => {
  it("contains the searchable content and formatted money", () => {
    const text = buildClaimComposite(claim());
    expect(text).toContain("Grace Lee");
    expect(text).toContain("Youth retreat supplies");
    expect(text).toContain("210 Youth — Retreat");
    expect(text).toContain("folding tables ($102.10)");
    expect(text).toContain("Costco Wholesale, Amazon");
    expect(text).toContain("Total $133.05");
  });

  it("omits excluded rows — excluding is a content change", () => {
    const withText = buildClaimComposite(claim());
    expect(withText).not.toContain("Personal snacks");
    const restored = claim();
    restored.lineItems[2].isExcluded = false;
    expect(claimFingerprint(restored)).not.toBe(claimFingerprint(claim()));
  });

  it("keeps CJK content untouched", () => {
    const text = buildClaimComposite(
      claim({ claimDescription: "青年退修会用品", ownerName: "王姐妹" })
    );
    expect(text).toContain("青年退修会用品");
    expect(text).toContain("王姐妹");
  });

  it("truncates a huge claim to the byte budget with an omission tail", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      description: `第${i}项 很长的中文描述内容以便快速吃掉字节预算`,
      amountCents: 100 + i,
      ministry: "210 Youth",
      event: "",
      isExcluded: false,
    }));
    const text = buildClaimComposite(claim({ lineItems: items }));
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(COMPOSITE_BYTE_BUDGET + 100);
    expect(text).toMatch(/… and \d+ more items/);
    expect(text).toContain("Total $133.05"); // the tail always survives
  });

  it("fingerprint is stable for identical content", () => {
    expect(claimFingerprint(claim())).toBe(claimFingerprint(claim()));
  });
});

describe("receipt fingerprint + year (SEARCH_DESIGN §4/§6.5)", () => {
  const base = {
    fileSha256: "abc",
    note: "retreat tables",
    merchant: "Costco",
    purchaseDate: "2024-05-12",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
  it("covers every embedded text input, not just the image", () => {
    const fp = receiptFingerprint(base);
    expect(receiptFingerprint({ ...base, note: "x" })).not.toBe(fp);
    expect(receiptFingerprint({ ...base, merchant: "x" })).not.toBe(fp);
    expect(receiptFingerprint({ ...base, purchaseDate: "2024-05-13" })).not.toBe(fp);
    expect(receiptFingerprint({ ...base, fileSha256: "x" })).not.toBe(fp);
  });
  it("prompt pairs note + merchant with the pixels", () => {
    const p = receiptPromptText(base);
    expect(p).toContain("Costco");
    expect(p).toContain("retreat tables");
  });
  it("year: purchaseDate prefix when date-like, else upload year", () => {
    expect(receiptYear(base)).toBe(2024);
    expect(receiptYear({ ...base, purchaseDate: "" })).toBe(2026);
    expect(receiptYear({ ...base, purchaseDate: "n/a" })).toBe(2026);
    expect(receiptYear({ ...base, purchaseDate: "9999-01-01" })).toBe(2026); // implausible year
  });
  it("claim year: submittedAt wins over createdAt", () => {
    expect(claimYear({ createdAt: new Date("2025-12-30T00:00:00Z"), submittedAt: null })).toBe(2025);
    expect(
      claimYear({ createdAt: new Date("2025-12-30T00:00:00Z"), submittedAt: new Date("2026-01-02T00:00:00Z") })
    ).toBe(2026);
  });
});

describe("exact-pass normalization (SEARCH_DESIGN §6.2)", () => {
  it("NFKC folds full-width IME input to half-width", () => {
    expect(normalizeQuery("２１４．８０")).toBe("214.80");
    expect(normalizeQuery("ＣＯＳＴＣＯ")).toBe("costco");
  });
  it("tokenizes on whitespace for AND matching", () => {
    expect(queryTerms("Costco folding  chairs")).toEqual(["costco", "folding", "chairs"]);
  });
  it("escapes LIKE wildcards", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
  });
  it("parses money incl. Chinese input habits", () => {
    expect(parseQueryMoneyCents("$214.80")).toBe(21480);
    expect(parseQueryMoneyCents("214.8")).toBe(21480);
    expect(parseQueryMoneyCents("¥214.80")).toBe(21480);
    expect(parseQueryMoneyCents("214.8元")).toBe(21480);
    expect(parseQueryMoneyCents("２１４．８０")).toBe(21480);
    expect(parseQueryMoneyCents("-27.98")).toBe(-2798);
    expect(parseQueryMoneyCents("1,234.56")).toBe(123456);
    expect(parseQueryMoneyCents("costco")).toBeNull();
    expect(parseQueryMoneyCents("2024-05-12")).toBeNull();
  });
});

describe("mock embeddings (SEARCH_DESIGN §3.1 — similarity-meaningful)", () => {
  it("returns unit vectors", () => {
    const v = mockEmbed("costco receipt", cfgA);
    expect(Math.abs(Math.sqrt(dot(v, v)) - 1)).toBeLessThan(1e-5);
  });
  it("ranks by shared tokens (English)", () => {
    const q = mockEmbed("costco folding tables", cfgA);
    const costco = mockEmbed("Costco Wholesale folding tables receipt", cfgA);
    const other = mockEmbed("Starbucks grande latte muffin", cfgA);
    expect(dot(q, costco)).toBeGreaterThan(dot(q, other) + 0.1);
  });
  it("folds CJK bigrams — Chinese fixtures rank for Chinese queries", () => {
    expect(mockTokens("退修会零食")).toContain("退修");
    const q = mockEmbed("退修会的零食", cfgA);
    const zh = mockEmbed("收据 退修会零食 王姐妹", cfgA);
    const other = mockEmbed("五金店 木材 螺丝", cfgA);
    expect(dot(q, zh)).toBeGreaterThan(dot(q, other) + 0.1);
  });
  it("salts by model — two mock models are deliberately incompatible", () => {
    const a = mockEmbed("costco folding tables", cfgA);
    const b = mockEmbed("costco folding tables", cfgB);
    expect(Math.abs(dot(a, b))).toBeLessThan(0.3);
  });
  it("__EMBED_FAIL__ throws (the degraded-mode test lever)", () => {
    expect(() => mockEmbed("anything __EMBED_FAIL__", cfgA)).toThrow();
  });
});
