import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  ZOOM_STEP,
  beginPinch,
  clampView,
  contentPointUnder,
  isIdentity,
  panStep,
  panView,
  pinchView,
  zoomAbout,
  zoomByCenter,
  type View,
} from "@/lib/esign/viewport";

/**
 * Zoom/pan math for the signing preview. This is the exact code
 * DocumentSignField runs for its pinch-to-zoom, zoom buttons, and drag-to-pan,
 * with the DOM's getBoundingClientRect stubbed out as a plain Box — so the
 * gesture arithmetic (focal-point preservation, pan clamping) is pinned here
 * where a DOM-less unit test can reach it.
 */

const BOX = { width: 400, height: 800 };
const IDENTITY: View = { scale: 1, tx: 0, ty: 0 };
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe("clampView", () => {
  it("snaps back to the origin at scale 1 (content exactly fills the box)", () => {
    expect(clampView({ scale: 1, tx: 50, ty: -30 }, BOX)).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it("clamps scale into [MIN,MAX]", () => {
    expect(clampView({ scale: 99, tx: 0, ty: 0 }, BOX).scale).toBe(MAX_SCALE);
    expect(clampView({ scale: 0.1, tx: 0, ty: 0 }, BOX).scale).toBe(1);
  });

  it("keeps translation within [box·(1−scale), 0] so content never leaves the frame", () => {
    // At 2×, the content is twice the box; pan can run from -box to 0.
    const pushedTooFar = clampView({ scale: 2, tx: 500, ty: -5000 }, BOX);
    expect(pushedTooFar.tx).toBe(0); // can't pull the left edge inward past the frame
    expect(pushedTooFar.ty).toBe(BOX.height * (1 - 2)); // -800, the far bottom bound
    const inRange = clampView({ scale: 2, tx: -100, ty: -200 }, BOX);
    expect(inRange).toEqual({ scale: 2, tx: -100, ty: -200 });
  });
});

describe("contentPointUnder (inverse of the transform)", () => {
  it("recovers the content point beneath a box point", () => {
    const v: View = { scale: 2, tx: -100, ty: -200 };
    // box point (100,200) → ((100−(−100))/2, (200−(−200))/2) = (100,200)
    expect(contentPointUnder(v, 100, 200)).toEqual({ cx: 100, cy: 200 });
  });
});

describe("zoomAbout — focal point stays put", () => {
  it("keeps the content under the focal point fixed while zooming in", () => {
    const focalX = 300;
    const focalY = 500;
    const before = contentPointUnder(IDENTITY, focalX, focalY);
    const zoomed = zoomAbout(IDENTITY, BOX, focalX, focalY, 3);
    const after = contentPointUnder(zoomed, focalX, focalY);
    expect(zoomed.scale).toBe(3);
    near(after.cx, before.cx);
    near(after.cy, before.cy);
  });

  it("respects MAX_SCALE even when asked for more", () => {
    expect(zoomAbout(IDENTITY, BOX, 200, 400, 10).scale).toBe(MAX_SCALE);
  });
});

describe("zoomByCenter (the +/− buttons)", () => {
  it("zooms in about the box centre by ZOOM_STEP", () => {
    const inOnce = zoomByCenter(IDENTITY, BOX, ZOOM_STEP);
    expect(inOnce.scale).toBeCloseTo(ZOOM_STEP, 6);
    // Box centre content point is unmoved.
    const c = contentPointUnder(inOnce, BOX.width / 2, BOX.height / 2);
    near(c.cx, BOX.width / 2);
    near(c.cy, BOX.height / 2);
  });

  it("zoom-out is the inverse and floors at 100%, snapping offsets away", () => {
    const zoomed = zoomByCenter(IDENTITY, BOX, ZOOM_STEP);
    const back = zoomByCenter(zoomed, BOX, 1 / ZOOM_STEP);
    expect(back.scale).toBeCloseTo(1, 6);
    const floored = zoomByCenter(back, BOX, 1 / ZOOM_STEP);
    expect(isIdentity(floored)).toBe(true);
  });
});

describe("panView (drag-to-pan when zoomed)", () => {
  const zoomed: View = { scale: 2, tx: -100, ty: -100 };

  it("translates by the pointer delta", () => {
    const start = { x: 200, y: 200, tx: zoomed.tx, ty: zoomed.ty };
    const moved = panView(zoomed, BOX, start, 160, 150); // Δ = (-40,-50)
    expect(moved).toEqual({ scale: 2, tx: -140, ty: -150 });
  });

  it("clamps at the frame edge instead of exposing background", () => {
    const start = { x: 200, y: 200, tx: zoomed.tx, ty: zoomed.ty };
    const dragged = panView(zoomed, BOX, start, 900, 200); // huge rightward drag
    expect(dragged.tx).toBe(0); // can't pull left edge inward past the frame
  });
});

describe("panStep — incremental pan that chains vertical overflow", () => {
  it("at scale 1 the content can't move, so the whole vertical delta overflows", () => {
    // This is the fix: touching the un-zoomed preview must not trap the page —
    // every pixel of the drag becomes scroll for the surrounding panel.
    const { view, overflowY } = panStep(IDENTITY, BOX, 0, 40);
    expect(view).toEqual(IDENTITY);
    expect(overflowY).toBe(40);
  });

  it("absorbs the delta fully while the zoomed content still has room", () => {
    const zoomed: View = { scale: 2, tx: -100, ty: -400 }; // mid-range (ty ∈ [-800,0])
    const { view, overflowY } = panStep(zoomed, BOX, 0, 30);
    expect(view.ty).toBe(-370);
    expect(overflowY).toBe(0);
  });

  it("chains the leftover once the top edge is reached", () => {
    // Near the top (ty=-10, edge at ty=0): a 30px downward drag moves 10px to
    // the edge, then the remaining 20px overflows to the scroller.
    const { view, overflowY } = panStep({ scale: 2, tx: 0, ty: -10 }, BOX, 0, 30);
    expect(view.ty).toBe(0);
    expect(overflowY).toBe(20);
  });

  it("chains a negative delta at the bottom edge (drag further down the page)", () => {
    const atBottom: View = { scale: 2, tx: 0, ty: BOX.height * (1 - 2) }; // -800
    const { view, overflowY } = panStep(atBottom, BOX, 0, -25);
    expect(view.ty).toBe(BOX.height * (1 - 2));
    expect(overflowY).toBe(-25);
  });
});

describe("pinchView — two-finger zoom", () => {
  it("scales by the finger-distance ratio and anchors the midpoint", () => {
    const midX = 200;
    const midY = 400;
    const start = beginPinch(IDENTITY, BOX, midX, midY, 100);
    // Fingers spread 2× apart → 2× zoom.
    const zoomed = pinchView(start, BOX, midX, midY, 200);
    expect(zoomed.scale).toBeCloseTo(2, 6);
    const c = contentPointUnder(zoomed, midX, midY);
    near(c.cx, midX);
    near(c.cy, midY);
  });

  it("follows the midpoint as the fingers travel together (two-finger pan)", () => {
    const zoomed: View = { scale: 2, tx: -150, ty: -300 };
    const start = beginPinch(zoomed, BOX, 200, 400, 100);
    const anchor = contentPointUnder(zoomed, 200, 400);
    // Same spread (no scale change) but the midpoint slides.
    const moved = pinchView(start, BOX, 180, 360, 100);
    expect(moved.scale).toBeCloseTo(2, 6);
    // The anchored content point stays under the (moved) midpoint.
    const after = contentPointUnder(moved, 180, 360);
    near(after.cx, anchor.cx);
    near(after.cy, anchor.cy);
  });
});
