import { describe, expect, it } from "vitest";
import { nextPreset, zoomPresets } from "@/lib/zoom-presets";

/**
 * The receipt viewer's preset button cycle (fit height → fit width → 2× fit).
 * These rules are what keeps the three-button pill stable: the button always
 * exists and always has a next stop, whatever freehand zoom the user is at.
 */

// A tall receipt: 400-wide column, 300-tall window, image laid out 400×1000.
const BOX = { width: 400, height: 300 };
const TALL = { width: 400, height: 1000 };
// A wide receipt fully visible at fit-width: window shrinks to its height.
const WIDE_BOX = { width: 400, height: 250 };
const WIDE = { width: 400, height: 250 };

describe("zoomPresets", () => {
  it("tall content: contain fit first, then the other axis, then 2× the tighter fit", () => {
    const ps = zoomPresets(BOX, TALL);
    expect(ps.map((p) => p.kind)).toEqual(["fitHeight", "fitWidth", "zoom2x"]);
    expect(ps[0].scale).toBeCloseTo(0.3, 6); // 300/1000
    expect(ps[1].scale).toBe(1);
    expect(ps[2].scale).toBe(2); // 2× the more zoomed-in fit (fit-width)
  });

  it("equal fits collapse into a single whole-image stop", () => {
    const ps = zoomPresets(WIDE_BOX, WIDE);
    expect(ps.map((p) => p.kind)).toEqual(["fitImage", "zoom2x"]);
    expect(ps[0].scale).toBe(1);
    expect(ps[1].scale).toBe(2);
  });

  it("letterboxed-both-ways content still yields contain then 2×", () => {
    // Content twice the box on both axes at scale 1.
    const ps = zoomPresets({ width: 400, height: 300 }, { width: 800, height: 600 });
    expect(ps.map((p) => p.kind)).toEqual(["fitImage", "zoom2x"]);
    expect(ps[0].scale).toBeCloseTo(0.5, 6);
    expect(ps[1].scale).toBeCloseTo(1, 6);
  });
});

describe("nextPreset", () => {
  it("cycles through the stops and wraps", () => {
    expect(nextPreset(BOX, TALL, 0.3).kind).toBe("fitWidth");
    expect(nextPreset(BOX, TALL, 1).kind).toBe("zoom2x");
    expect(nextPreset(BOX, TALL, 2).kind).toBe("fitHeight"); // wrap to contain
  });

  it("treats a within-1% scale as sitting on the stop", () => {
    expect(nextPreset(BOX, TALL, 0.301).kind).toBe("fitWidth");
    expect(nextPreset(BOX, TALL, 1.009).kind).toBe("zoom2x");
  });

  it("returns to the whole-image fit from any freehand zoom", () => {
    expect(nextPreset(BOX, TALL, 2.5).kind).toBe("fitHeight");
    expect(nextPreset(BOX, TALL, 1.5).kind).toBe("fitHeight");
    expect(nextPreset(WIDE_BOX, WIDE, 2.5).kind).toBe("fitImage");
  });
});
