import { describe, expect, it, beforeEach } from "vitest";
import {
  dot,
  invalidateIndexCache,
  indexCacheUpsert,
  indexCacheRemove,
  type IndexEntry,
} from "@/lib/embeddings/index-cache";

/**
 * The in-memory scoring engine (docs/SEARCH_DESIGN.md §6.4). Only `dot` and the
 * delta helpers are DB-free; `indexEntries`/`reload` hit Prisma and are out of
 * scope here. The delta helpers key off the module's globalThis cache, so we
 * reach into it to stage the "loaded" precondition the worker relies on.
 */

type CacheState = {
  version: number;
  loadedVersion: number;
  loadedModel: string;
  entries: Map<string, IndexEntry>;
  loading: Promise<void> | null;
};
const g = globalThis as unknown as { __embedIndex?: CacheState };

function entry(over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    kind: "receipt",
    targetId: "r1",
    userId: "u1",
    year: 2026,
    vector: new Float32Array([1, 0, 0]),
    ...over,
  };
}

/** Force the cache into a "loaded @ current version, model M" state so that
 *  indexCacheUpsert's guard passes and deltas apply in-process. */
function setLoaded(model: string): CacheState {
  invalidateIndexCache(); // ensures the global exists; bumps version
  const s = g.__embedIndex!;
  s.entries = new Map();
  s.loadedModel = model;
  s.loadedVersion = s.version;
  return s;
}

describe("dot", () => {
  it("identical unit vectors give cosine 1", () => {
    const v = new Float32Array([1, 0, 0]);
    expect(dot(v, v)).toBe(1);
  });

  it("orthogonal vectors give 0", () => {
    expect(dot(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
  });

  it("a zero vector always scores 0", () => {
    expect(dot(new Float32Array([0, 0, 0]), new Float32Array([5, -3, 9]))).toBe(0);
  });

  it("computes the plain inner product incl. negatives", () => {
    // 1*4 + 2*5 + 3*6 = 32
    expect(dot(new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6]))).toBe(32);
    // 1*-1 + -2*3 = -7
    expect(dot(new Float32Array([1, -2]), new Float32Array([-1, 3]))).toBe(-7);
  });

  it("ranges over the min length when dimensions differ", () => {
    // trailing 3 in `a` has no partner and is ignored
    expect(dot(new Float32Array([1, 2, 3]), new Float32Array([1, 2]))).toBe(5);
    expect(dot(new Float32Array([1, 2]), new Float32Array([1, 2, 99]))).toBe(5);
  });

  it("empty arrays score 0", () => {
    expect(dot(new Float32Array([]), new Float32Array([]))).toBe(0);
    expect(dot(new Float32Array([]), new Float32Array([1, 2]))).toBe(0);
  });

  it("float32 rounding: opposite unit vectors give -1", () => {
    const a = new Float32Array([0.6, 0.8]);
    const b = new Float32Array([-0.6, -0.8]);
    expect(dot(a, b)).toBeCloseTo(-1, 6);
  });
});

describe("indexCacheUpsert / indexCacheRemove (worker deltas)", () => {
  beforeEach(() => setLoaded("model-A"));

  it("applies an upsert when loaded at the matching model+version", () => {
    indexCacheUpsert(entry(), "model-A");
    expect(g.__embedIndex!.entries.get("receipt:r1")).toMatchObject({ targetId: "r1" });
  });

  it("is a no-op when the model does not match the loaded model", () => {
    indexCacheUpsert(entry(), "model-B");
    expect(g.__embedIndex!.entries.size).toBe(0);
  });

  it("is a no-op once the version has moved past the loaded version", () => {
    invalidateIndexCache(); // loadedVersion now lags version
    indexCacheUpsert(entry(), "model-A");
    expect(g.__embedIndex!.entries.size).toBe(0);
  });

  it("keys by kind:targetId, so same id under two kinds coexist", () => {
    indexCacheUpsert(entry({ kind: "receipt", targetId: "x" }), "model-A");
    indexCacheUpsert(entry({ kind: "claim", targetId: "x" }), "model-A");
    expect([...g.__embedIndex!.entries.keys()].sort()).toEqual(["claim:x", "receipt:x"]);
  });

  it("upserting the same key overwrites the prior entry", () => {
    indexCacheUpsert(entry({ year: 2024 }), "model-A");
    indexCacheUpsert(entry({ year: 2025 }), "model-A");
    expect(g.__embedIndex!.entries.get("receipt:r1")!.year).toBe(2025);
    expect(g.__embedIndex!.entries.size).toBe(1);
  });

  it("remove deletes regardless of version/model guard", () => {
    indexCacheUpsert(entry(), "model-A");
    invalidateIndexCache(); // stale — but remove has no guard
    indexCacheRemove("receipt", "r1");
    expect(g.__embedIndex!.entries.has("receipt:r1")).toBe(false);
  });

  it("removing a missing key is a silent no-op", () => {
    expect(() => indexCacheRemove("claim", "nope")).not.toThrow();
    expect(g.__embedIndex!.entries.size).toBe(0);
  });
});

describe("invalidateIndexCache", () => {
  it("bumps the version counter by one each call", () => {
    setLoaded("model-A");
    const before = g.__embedIndex!.version;
    invalidateIndexCache();
    invalidateIndexCache();
    expect(g.__embedIndex!.version).toBe(before + 2);
  });
});
