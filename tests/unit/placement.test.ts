import { describe, expect, it } from "vitest";
import { clampPlacement, fitWidthToHeight, type SignaturePlacement } from "@/lib/esign/placement";

// The CFCC template is 612×792 and the signature anchor is a fixed 144pt-wide
// column (widthRatio = 144/612 ≈ 0.2353). The printed-name line is ~18pt tall,
// which is the height the stamp should fit within.
const PAGE_W = 612;
const PAGE_H = 792;
const ANCHOR_WIDTH_RATIO = 144 / PAGE_W;
const MAX_HEIGHT_RATIO = 18 / PAGE_H;

// heightPerWidth = imgAspect × pageW/pageH (height as a fraction of page height
// per unit of widthRatio), mirroring DocumentSignField's math.
const heightPerWidth = (imgAspect: number) => imgAspect * (PAGE_W / PAGE_H);
// Rendered stamp height in points for a given fitted width + image aspect.
const stampHeightPt = (widthRatio: number, imgAspect: number) =>
  widthRatio * PAGE_W * imgAspect;

describe("fitWidthToHeight", () => {
  it("leaves a wide signature untouched (already within the line height)", () => {
    // A 5:1 signature (aspect 0.2) at full column width is 144 × 28.8pt — but
    // the column is what bounds it, not the height cap once it's this wide.
    const imgAspect = 0.12; // 144pt wide → 17.3pt tall, under the 18pt cap
    const fitted = fitWidthToHeight(ANCHOR_WIDTH_RATIO, heightPerWidth(imgAspect), MAX_HEIGHT_RATIO);
    expect(fitted).toBeCloseTo(ANCHOR_WIDTH_RATIO, 6);
  });

  it("shrinks a near-square mark so it no longer balloons off the line", () => {
    const imgAspect = 1; // a "T"-like square doodle
    const fitted = fitWidthToHeight(ANCHOR_WIDTH_RATIO, heightPerWidth(imgAspect), MAX_HEIGHT_RATIO);
    expect(fitted).toBeLessThan(ANCHOR_WIDTH_RATIO);
    // Rendered height now lands on the ~18pt line instead of ~144pt.
    expect(stampHeightPt(fitted, imgAspect)).toBeCloseTo(18, 5);
    expect(stampHeightPt(ANCHOR_WIDTH_RATIO, imgAspect)).toBeCloseTo(144, 5);
  });

  it("caps a typical signature's height at the line while keeping it in-column", () => {
    const imgAspect = 0.3; // ~3.3:1, a normal signature
    const fitted = fitWidthToHeight(ANCHOR_WIDTH_RATIO, heightPerWidth(imgAspect), MAX_HEIGHT_RATIO);
    expect(stampHeightPt(fitted, imgAspect)).toBeCloseTo(18, 5);
    // Width stays within the 144pt column (never widened).
    expect(fitted).toBeLessThanOrEqual(ANCHOR_WIDTH_RATIO + 1e-9);
    expect(fitted * PAGE_W).toBeGreaterThan(0);
  });

  it("never widens and guards against degenerate inputs", () => {
    expect(fitWidthToHeight(0.1, 0, MAX_HEIGHT_RATIO)).toBe(0.1);
    expect(fitWidthToHeight(0.1, heightPerWidth(0.3), 0)).toBe(0.1);
    // A larger cap than needed is a no-op.
    expect(fitWidthToHeight(0.1, heightPerWidth(0.1), 1)).toBe(0.1);
  });

  it("stays draggable after clamping even for a square mark", () => {
    const imgAspect = 1;
    const fitted = fitWidthToHeight(ANCHOR_WIDTH_RATIO, heightPerWidth(imgAspect), MAX_HEIGHT_RATIO);
    const placement: SignaturePlacement = { page: 0, xRatio: 0.16, yRatio: 0.23, widthRatio: fitted };
    const clamped = clampPlacement(placement, heightPerWidth(imgAspect));
    // clampPlacement enforces a 0.06 minimum width so the stamp stays grabbable;
    // the result is still far smaller than the un-fitted 0.2353 column.
    expect(clamped.widthRatio).toBeGreaterThanOrEqual(0.06);
    expect(clamped.widthRatio).toBeLessThan(ANCHOR_WIDTH_RATIO);
  });
});
