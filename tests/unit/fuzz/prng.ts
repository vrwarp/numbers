/**
 * Deterministic pseudo-random fuzz harness for the unit suite.
 *
 * Every fuzz test derives its cases from a fixed seed (mulberry32), so runs
 * are reproducible: a failure always prints the exact seed + iteration that
 * broke, and re-running with FUZZ_SEED=<n> FUZZ_ITERS=1 replays just that
 * case. CI stability matters more than novelty here — the suite exists to
 * catch regressions introduced by future edits, not to explore forever.
 *
 *   FUZZ_ITERS=<n>  override the per-test iteration count (default per call)
 *   FUZZ_SEED=<n>   run every iteration from this single seed (replay mode)
 */
import { test } from "vitest";

/** mulberry32 — small, fast, well-distributed 32-bit seeded PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience wrapper exposing typed draw helpers over a seeded stream. */
export class Rng {
  readonly seed: number;
  private next: () => number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.next = mulberry32(this.seed);
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Uniform float in [lo, hi). */
  floatIn(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Uniform integer in [lo, hi] (inclusive). */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("pick from empty array");
    return arr[this.int(0, arr.length - 1)];
  }

  /** Fisher–Yates shuffle (returns a new array). */
  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  array<T>(len: number, gen: (rng: Rng, i: number) => T): T[] {
    return Array.from({ length: len }, (_, i) => gen(this, i));
  }

  /** Integer cents in a realistic signed range (default ±$100k). */
  cents(maxAbs = 10_000_000): number {
    return this.int(-maxAbs, maxAbs);
  }

  /** Printable-ASCII string. */
  asciiString(maxLen = 24): string {
    const len = this.int(0, maxLen);
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.int(0x20, 0x7e));
    return s;
  }

  /**
   * Adversarial unicode string: mixes ASCII, CJK, full-width forms, emoji
   * (surrogate pairs), combining marks, zero-width and bidi controls — the
   * kinds of input receipts/IMEs/merchant names actually produce.
   */
  unicodeString(maxLen = 24): string {
    const pools: readonly (readonly [number, number])[] = [
      [0x20, 0x7e], // ASCII
      [0x4e00, 0x9fff], // CJK unified
      [0xff01, 0xff5e], // full-width forms
      [0x0300, 0x036f], // combining marks
      [0x0590, 0x05ff], // Hebrew (RTL)
    ];
    const specials = ["​", "‎", "‮", "﻿", "😀", "🧾", "\t", "\n"];
    const len = this.int(0, maxLen);
    let s = "";
    for (let i = 0; i < len; i++) {
      if (this.bool(0.15)) s += this.pick(specials);
      else {
        const [lo, hi] = this.pick(pools);
        s += String.fromCharCode(this.int(lo, hi));
      }
    }
    return s;
  }
}

const ENV_ITERS = process.env.FUZZ_ITERS ? Number(process.env.FUZZ_ITERS) : undefined;
const ENV_SEED = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : undefined;

/**
 * Run `body` for `iters` deterministic iterations, each with its own Rng
 * seeded from `baseSeed + i`. On failure the thrown error is annotated with
 * the seed + iteration so the case can be replayed exactly:
 *   FUZZ_SEED=<seed> FUZZ_ITERS=1 npx vitest run <file> -t "<name>"
 */
export function fuzz(
  name: string,
  opts: { iters?: number; seed?: number },
  body: (rng: Rng, iteration: number) => void | Promise<void>
): void {
  const iters = ENV_ITERS ?? opts.iters ?? 200;
  const baseSeed = ENV_SEED ?? opts.seed ?? hashSeed(name);
  test(`${name} [fuzz x${iters}]`, async () => {
    for (let i = 0; i < iters; i++) {
      const seed = ENV_SEED !== undefined ? ENV_SEED : (baseSeed + i) >>> 0;
      try {
        await body(new Rng(seed), i);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        e.message = `[fuzz seed=${seed} iteration=${i}] ${e.message}\nReplay: FUZZ_SEED=${seed} FUZZ_ITERS=1`;
        throw e;
      }
    }
  });
}

/** Stable 32-bit FNV-1a hash so each fuzz test gets its own default seed. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
