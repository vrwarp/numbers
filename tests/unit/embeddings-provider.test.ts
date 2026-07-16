import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  EmbedError,
  maxPx,
  embedText,
  embedImage,
  probeEndpoint,
  mockTokens,
} from "@/lib/embeddings/provider";
import { MOCK_DIM } from "@/lib/embeddings/mock";

/**
 * The provider's DB-/network-free surface. `finalize`/`firstVector` (the real
 * dim-check + L2-normalize + zero-norm rejection) are module-private and only
 * reachable through a live endpoint, so we pin the exported EmbedError, the
 * maxPx config knob, and the deterministic EMBEDDING_MOCK code paths (which
 * produce the same unit vectors the real path guarantees).
 */

const cfg = { endpoint: "http://unused", apiKey: "k", model: "mock-model", dim: MOCK_DIM };
const norm = (v: Float32Array) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe("EmbedError", () => {
  it("is an Error carrying an optional HTTP status", () => {
    const e = new EmbedError("boom", 429);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("boom");
    expect(e.status).toBe(429);
  });

  it("leaves status undefined when omitted", () => {
    expect(new EmbedError("x").status).toBeUndefined();
  });
});

describe("maxPx", () => {
  const saved = process.env.EMBEDDING_MAX_PX;
  afterEach(() => {
    if (saved === undefined) delete process.env.EMBEDDING_MAX_PX;
    else process.env.EMBEDDING_MAX_PX = saved;
  });

  it("defaults to 640 when unset", () => {
    delete process.env.EMBEDDING_MAX_PX;
    expect(maxPx()).toBe(640);
  });

  it("honors the configured override", () => {
    process.env.EMBEDDING_MAX_PX = "512";
    expect(maxPx()).toBe(512);
  });
});

describe("EMBEDDING_MOCK code paths", () => {
  const saved = process.env.EMBEDDING_MOCK;
  beforeEach(() => {
    process.env.EMBEDDING_MOCK = "1";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.EMBEDDING_MOCK;
    else process.env.EMBEDDING_MOCK = saved;
  });

  it("embedText returns a deterministic unit vector of cfg.dim", async () => {
    const v = await embedText("costco folding tables", cfg);
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(MOCK_DIM);
    expect(norm(v)).toBeCloseTo(1, 5);
    const again = await embedText("costco folding tables", cfg);
    expect([...again]).toEqual([...v]);
  });

  it("embedText distinguishes different text", async () => {
    const a = await embedText("costco", cfg);
    const b = await embedText("starbucks", cfg);
    expect([...a]).not.toEqual([...b]);
  });

  it("embedText surfaces the mock failure lever", async () => {
    await expect(embedText("boom __EMBED_FAIL__", cfg)).rejects.toThrow(/EMBED_FAIL/);
  });

  it("embedImage returns a unit vector folding bytes + paired text", async () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    const v = await embedImage(bytes, "a receipt", cfg);
    expect(v.length).toBe(MOCK_DIM);
    expect(norm(v)).toBeCloseTo(1, 5);
    const same = await embedImage(bytes, "a receipt", cfg);
    expect([...same]).toEqual([...v]);
    const diff = await embedImage(Buffer.from([9, 9, 9]), "a receipt", cfg);
    expect([...diff]).not.toEqual([...v]);
  });

  it("probeEndpoint reports the mock dimension without a network call", async () => {
    await expect(probeEndpoint(cfg)).resolves.toEqual({ dim: MOCK_DIM, ms: 1 });
  });
});

describe("mockTokens (re-exported)", () => {
  it("tokenizes on non-alphanumerics and lowercases", () => {
    expect(mockTokens("Costco  Folding-Tables")).toEqual(["costco", "folding", "tables"]);
  });

  it("indexes CJK bigrams", () => {
    expect(mockTokens("退修会")).toEqual(["退修", "修会"]);
  });

  it("emits nothing for pure punctuation", () => {
    expect(mockTokens("  --  ")).toEqual([]);
  });
});
