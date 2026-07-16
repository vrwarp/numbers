import { describe, expect, it } from "vitest";
import {
  clampPlacement,
  placementsEqual,
  roundPlacement,
  type SignaturePlacement,
} from "@/lib/esign/placement";

// Complements placement.test.ts (fitWidthToHeight + one clampPlacement case)
// with the untested helpers: roundPlacement, placementsEqual, and the
// clampPlacement width/x/y bounds.

describe("roundPlacement", () => {
  it("rounds ratios to 4 decimals and truncates page to an int", () => {
    expect(roundPlacement({ page: 2.9, xRatio: 0.123456, yRatio: 0.987654, widthRatio: 0.20005 })).toEqual(
      { page: 2, xRatio: 0.1235, yRatio: 0.9877, widthRatio: 0.2001 }
    );
  });

  it("leaves already-4dp values byte-stable (idempotent)", () => {
    const p: SignaturePlacement = { page: 0, xRatio: 0.16, yRatio: 0.23, widthRatio: 0.2353 };
    const once = roundPlacement(p);
    expect(roundPlacement(once)).toEqual(once);
  });

  it("floors a negative page toward zero via | 0", () => {
    // Bitwise OR truncates toward zero, not toward -Infinity.
    expect(roundPlacement({ page: -1.8, xRatio: 0, yRatio: 0, widthRatio: 0 }).page).toBe(-1);
  });
});

describe("placementsEqual", () => {
  const base: SignaturePlacement = { page: 1, xRatio: 0.1, yRatio: 0.2, widthRatio: 0.3 };

  it("both undefined are equal; one undefined is not", () => {
    expect(placementsEqual(undefined, undefined)).toBe(true);
    expect(placementsEqual(base, undefined)).toBe(false);
    expect(placementsEqual(undefined, base)).toBe(false);
  });

  it("true for identical field values", () => {
    expect(placementsEqual(base, { ...base })).toBe(true);
  });

  it("false when any single field differs", () => {
    expect(placementsEqual(base, { ...base, page: 2 })).toBe(false);
    expect(placementsEqual(base, { ...base, xRatio: 0.11 })).toBe(false);
    expect(placementsEqual(base, { ...base, yRatio: 0.21 })).toBe(false);
    expect(placementsEqual(base, { ...base, widthRatio: 0.31 })).toBe(false);
  });
});

describe("clampPlacement bounds", () => {
  it("clamps width into [0.06, 0.6]", () => {
    expect(clampPlacement({ page: 0, xRatio: 0, yRatio: 0, widthRatio: 0.01 }, 0.5).widthRatio).toBe(0.06);
    expect(clampPlacement({ page: 0, xRatio: 0, yRatio: 0, widthRatio: 0.9 }, 0.5).widthRatio).toBe(0.6);
    expect(clampPlacement({ page: 0, xRatio: 0, yRatio: 0, widthRatio: 0.3 }, 0.5).widthRatio).toBe(0.3);
  });

  it("keeps the stamp fully on-page (x within [0, 1-width])", () => {
    // width clamps to 0.6 → x may not exceed 0.4.
    expect(clampPlacement({ page: 0, xRatio: 0.95, yRatio: 0, widthRatio: 0.6 }, 0).xRatio).toBeCloseTo(0.4, 9);
    // negative x floors at 0.
    expect(clampPlacement({ page: 0, xRatio: -0.5, yRatio: 0, widthRatio: 0.2 }, 0).xRatio).toBe(0);
  });

  it("keeps the stamp fully on-page vertically (y within [0, 1-height])", () => {
    // height = width * aspect = 0.2 * 1 = 0.2, so y may not exceed 0.8.
    const c = clampPlacement({ page: 3, xRatio: 0.1, yRatio: 0.95, widthRatio: 0.2 }, 1);
    expect(c.yRatio).toBeCloseTo(0.8, 9);
    expect(c.widthRatio).toBe(0.2);
    // negative y floors at 0.
    expect(clampPlacement({ page: 0, xRatio: 0, yRatio: -1, widthRatio: 0.2 }, 1).yRatio).toBe(0);
  });

  it("passes the page index through untouched", () => {
    expect(clampPlacement({ page: 7, xRatio: 0.1, yRatio: 0.1, widthRatio: 0.2 }, 0.5).page).toBe(7);
  });

  it("a zero aspect leaves y unclamped by height (only floored at 0)", () => {
    // height = 0 → y capped at min(1, ...) = 1; an in-range y is untouched.
    expect(clampPlacement({ page: 0, xRatio: 0, yRatio: 0.99, widthRatio: 0.2 }, 0).yRatio).toBe(0.99);
  });
});
