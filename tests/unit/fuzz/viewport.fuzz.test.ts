import { describe, expect } from "vitest";
import {
  clampView,
  clampScale,
  contentPointUnder,
  zoomAbout,
  zoomByCenter,
  beginPinch,
  pinchView,
  panView,
  panStep,
  isIdentity,
  MIN_SCALE,
  MAX_SCALE,
  type View,
  type Box,
} from "@/lib/esign/viewport";
import { fuzz, Rng } from "./prng";

function randomBox(rng: Rng): Box {
  return { width: rng.int(50, 2000), height: rng.int(50, 2000) };
}

function randomView(rng: Rng): View {
  return {
    scale: rng.floatIn(-2, 8),
    tx: rng.floatIn(-5000, 5000),
    ty: rng.floatIn(-5000, 5000),
  };
}

function expectLegal(v: View, box: Box) {
  expect(v.scale).toBeGreaterThanOrEqual(MIN_SCALE);
  expect(v.scale).toBeLessThanOrEqual(MAX_SCALE);
  expect(v.tx).toBeLessThanOrEqual(0);
  expect(v.ty).toBeLessThanOrEqual(0);
  expect(v.tx).toBeGreaterThanOrEqual(box.width * (1 - v.scale) - 1e-6);
  expect(v.ty).toBeGreaterThanOrEqual(box.height * (1 - v.scale) - 1e-6);
}

/**
 * The signing-preview zoom/pan math must never let the page escape the
 * viewport or the scale escape [MIN,MAX] — a broken clamp strands the user
 * on a blank preview mid-signature ceremony.
 */
describe("esign viewport fuzz", () => {
  fuzz("clampView always produces a legal view", { iters: 500 }, (rng) => {
    const box = randomBox(rng);
    const v = clampView(randomView(rng), box);
    expectLegal(v, box);
  });

  fuzz("clampView is idempotent", { iters: 400 }, (rng) => {
    const box = randomBox(rng);
    const once = clampView(randomView(rng), box);
    const twice = clampView(once, box);
    expect(twice).toEqual(once);
  });

  fuzz("scale at or below 1 always snaps to the identity translation", { iters: 300 }, (rng) => {
    const box = randomBox(rng);
    const v = clampView({ scale: rng.floatIn(-3, 1), tx: rng.floatIn(-100, 100), ty: rng.floatIn(-100, 100) }, box);
    expect(v.tx).toBe(0);
    expect(v.ty).toBe(0);
    expect(isIdentity(v)).toBe(v.scale === 1);
  });

  fuzz("zoomAbout preserves the focal content point when unclamped", { iters: 400 }, (rng) => {
    const box = randomBox(rng);
    // Start from a legal, strictly-interior view so clamping doesn't kick in.
    const scale = rng.floatIn(1.2, 3);
    const start = clampView({ scale, tx: rng.floatIn(box.width * (1 - scale), 0), ty: rng.floatIn(box.height * (1 - scale), 0) }, box);
    const boxX = rng.floatIn(0, box.width);
    const boxY = rng.floatIn(0, box.height);
    const before = contentPointUnder(start, boxX, boxY);
    const nextScale = rng.floatIn(1.2, 3.8);
    const zoomed = zoomAbout(start, box, boxX, boxY, nextScale);
    // Strictly interior by a 1e-6 margin (same tolerance as expectLegal): a
    // view within one ulp of a bound may or may not have been clamped
    // depending on how the bound was computed, so the focal-point property
    // only holds outside that boundary layer.
    if (zoomed.scale === nextScale && zoomed.tx < -1e-6 && zoomed.ty < -1e-6 &&
        zoomed.tx > box.width * (1 - zoomed.scale) + 1e-6 &&
        zoomed.ty > box.height * (1 - zoomed.scale) + 1e-6) {
      const after = contentPointUnder(zoomed, boxX, boxY);
      expect(after.cx).toBeCloseTo(before.cx, 6);
      expect(after.cy).toBeCloseTo(before.cy, 6);
    }
    expectLegal(zoomed, box);
  });

  fuzz("zoomByCenter always yields a legal view", { iters: 400 }, (rng) => {
    const box = randomBox(rng);
    const v = clampView(randomView(rng), box);
    const zoomed = zoomByCenter(v, box, rng.floatIn(0.1, 5));
    expectLegal(zoomed, box);
  });

  fuzz("pinch with zero start distance never divides by zero", { iters: 200 }, (rng) => {
    const box = randomBox(rng);
    const v = clampView(randomView(rng), box);
    const start = beginPinch(v, box, rng.floatIn(0, box.width), rng.floatIn(0, box.height), 0);
    const out = pinchView(start, box, rng.floatIn(0, box.width), rng.floatIn(0, box.height), rng.floatIn(0, 500));
    expect(Number.isFinite(out.scale)).toBe(true);
    expectLegal(out, box);
  });

  fuzz("random pinch sequences always stay legal", { iters: 300 }, (rng) => {
    const box = randomBox(rng);
    let v = clampView(randomView(rng), box);
    const start = beginPinch(v, box, rng.floatIn(0, box.width), rng.floatIn(0, box.height), rng.floatIn(1, 400));
    for (let i = 0; i < 10; i++) {
      v = pinchView(start, box, rng.floatIn(-100, box.width + 100), rng.floatIn(-100, box.height + 100), rng.floatIn(0, 800));
      expectLegal(v, box);
    }
  });

  fuzz("panView clamps any drag inside the frame", { iters: 400 }, (rng) => {
    const box = randomBox(rng);
    const v = clampView(randomView(rng), box);
    const start = { x: rng.floatIn(0, box.width), y: rng.floatIn(0, box.height), tx: v.tx, ty: v.ty };
    const out = panView(v, box, start, rng.floatIn(-3000, 3000), rng.floatIn(-3000, 3000));
    expectLegal(out, box);
  });

  fuzz("panStep conservation: absorbed movement + overflowY equals dy", { iters: 400 }, (rng) => {
    const box = randomBox(rng);
    const v = clampView(randomView(rng), box);
    const dy = rng.floatIn(-500, 500);
    const { view, overflowY } = panStep(v, box, rng.floatIn(-500, 500), dy);
    expect(view.ty - v.ty + overflowY).toBeCloseTo(dy, 6);
    expectLegal(view, box);
  });

  fuzz("at scale 1 a pan absorbs nothing — all dy overflows", { iters: 200 }, (rng) => {
    const box = randomBox(rng);
    const dy = rng.floatIn(-300, 300);
    const { view, overflowY } = panStep({ scale: 1, tx: 0, ty: 0 }, box, rng.floatIn(-300, 300), dy);
    expect(overflowY).toBeCloseTo(dy, 6);
    expect(isIdentity(view)).toBe(true);
  });

  fuzz("clampScale is monotonic and bounded", { iters: 200 }, (rng) => {
    const a = rng.floatIn(-10, 10);
    const b = rng.floatIn(-10, 10);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    expect(clampScale(lo)).toBeLessThanOrEqual(clampScale(hi));
    expect(clampScale(a)).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(clampScale(a)).toBeLessThanOrEqual(MAX_SCALE);
  });
});
