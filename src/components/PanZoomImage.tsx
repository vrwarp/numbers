"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  beginPinch,
  clampViewIn,
  fitScales,
  MAX_SCALE,
  panStepIn,
  pinchViewIn,
  zoomAboutIn,
  zoomByCenterIn,
  ZOOM_STEP,
  type Frame,
  type PinchStart,
  type View,
} from "@/lib/esign/viewport";
import { nextPreset, type ZoomPresetKind } from "@/lib/zoom-presets";

/**
 * Inline zoomable receipt image (review screen). Reuses the e-sign signing
 * surface's viewport math (src/lib/esign/viewport.ts) and its gesture
 * contract: the surface owns touch (touch-action: none, required for the
 * custom pinch), so a one-finger drag pans the zoomed image and chains
 * whatever the pan can't absorb into the surrounding scrollers — on a
 * fully-fitted image the whole drag scrolls the page, and a zoomed pan keeps
 * scrolling once it hits the top/bottom edge. Without this, a nested
 * overscroll-contain scroller swallowed touch scrolling dead on mobile.
 *
 * Unlike the signing box, the stage here is a fixed window — the height clamp
 * lives on it (via `className`), the image is never taller than the visible
 * area, and every camera move is this transform (nothing scrolls inside).
 * The image's layout size (w-full × natural aspect) is what scale 1 means;
 * the initial view is the contain fit — whichever axis fit shows the whole
 * photo, below 1 for a tall receipt. The pill is always the same three
 * buttons (−/+/preset) so nothing shifts as the zoom state changes; the
 * preset button cycles fit-height → fit-width → 2× fit.
 */

type Gesture = "none" | "pan" | "pinch";

/** Every ancestor that can actually scroll vertically, nearest first, ending
 *  with the page — pan overflow cascades through them in order. */
function scrollableAncestors(el: Element | null): Element[] {
  const out: Element[] = [];
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      out.push(node);
    }
  }
  const page = typeof document !== "undefined" ? document.scrollingElement : null;
  if (page && !out.includes(page)) out.push(page);
  return out;
}

const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_SLOP_PX = 30;
const TAP_MOVE_SLOP_PX = 12;
const DOUBLE_TAP_SCALE = 2.5;

// Fling (momentum) tuning — the surface owns touch, so native inertia never
// happens; this synthesizes it. Velocity is sampled over the drag's last
// ~100ms; the fling decays exponentially with iOS-like time constant.
const FLING_SAMPLE_MS = 100;
const FLING_MIN_START = 0.25; // px/ms
const FLING_MIN_KEEP = 0.02; // px/ms
const FLING_DECAY_TAU_MS = 325;

const PRESET_GLYPH: Record<ZoomPresetKind, string> = {
  fitImage: "⤢",
  fitHeight: "↕",
  fitWidth: "↔",
  zoom2x: "2×",
};

export default function PanZoomImage({
  src,
  alt,
  imgTestId,
  className,
}: {
  src: string;
  alt: string;
  imgTestId?: string;
  /** Sizing/background of the stage — the visible window (height clamp etc.). */
  className?: string;
}) {
  // Zoom strings already exist for the full-screen viewer — same verbs here.
  const t = useTranslations("Viewer");
  const [view, setViewState] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  const setView = (next: View) => {
    viewRef.current = next;
    setViewState(next);
  };

  // Measured geometry (stage window + image layout + fit bounds); null until
  // the image has laid out. In state because the buttons, preset glyph, and
  // cursor derive from it.
  const [frame, setFrameState] = useState<Frame | null>(null);
  const frameRef = useRef<Frame | null>(null);
  const setFrame = (f: Frame) => {
    frameRef.current = f;
    setFrameState(f);
  };

  // After the first zoom action, geometry changes re-clamp the user's view
  // instead of snapping back to the contain fit.
  const touched = useRef(false);
  const [dragging, setDragging] = useState(false);

  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const gesture = useRef<Gesture>("none");
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const panLast = useRef({ x: 0, y: 0 });
  const panMoved = useRef(0);
  const scrollParents = useRef<Element[]>([]);
  const pinchStart = useRef<PinchStart>({ dist: 0, scale: 1, cx: 0, cy: 0 });
  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  const flingSamples = useRef<{ t: number; x: number; y: number }[]>([]);
  const flingRaf = useRef<number | null>(null);

  const stageRect = () => boxRef.current?.getBoundingClientRect() ?? null;

  /** Measure the stage window and the image's untransformed layout size.
   *  Content height comes from the natural aspect, not offsetHeight — the
   *  integer-rounded DOM sizes would jitter the fit scales by a pixel. */
  const measure = (): Frame | null => {
    const img = imgRef.current;
    const r = stageRect();
    if (!img || !r || !r.width || !r.height || !img.naturalWidth || !img.naturalHeight) return null;
    const box = { width: r.width, height: r.height };
    const content = { width: r.width, height: (r.width * img.naturalHeight) / img.naturalWidth };
    const { fitWidth, fitHeight } = fitScales(box, content);
    return { box, content, minScale: Math.min(1, fitWidth, fitHeight), maxScale: MAX_SCALE };
  };

  /** Re-measure after any geometry change (image load, stage resize): apply
   *  the contain fit until the user has zoomed, then only re-clamp. */
  const refit = () => {
    const f = measure();
    if (!f) return;
    setFrame(f);
    setView(clampViewIn(f, touched.current ? viewRef.current : { scale: f.minScale, tx: 0, ty: 0 }));
  };

  useEffect(() => {
    const stage = boxRef.current;
    if (!stage) return;
    // Fires on observe too, which covers a cached (already-complete) image.
    const ro = new ResizeObserver(refit);
    ro.observe(stage);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Hand pan overflow to the scrollers, nearest first — each consumes what
   *  it can (an edge-pinned scroller consumes nothing) and passes the rest on.
   *  Returns the remainder nothing could consume (everything saturated). */
  function chainScroll(dy: number): number {
    let rest = dy;
    for (const p of scrollParents.current) {
      if (Math.abs(rest) < 0.5) break;
      const before = p.scrollTop;
      p.scrollTop = before - rest;
      rest -= before - p.scrollTop;
    }
    return rest;
  }

  function cancelFling() {
    if (flingRaf.current != null) cancelAnimationFrame(flingRaf.current);
    flingRaf.current = null;
  }
  useEffect(() => cancelFling, []);

  /** Decay a released drag's velocity, feeding the same pan+chain path each
   *  frame so the fling crosses the image/page boundary just like the finger
   *  did. Stops when it slows down or everything is saturated. */
  function startFling(vx0: number, vy0: number) {
    let vx = vx0;
    let vy = vy0;
    let prev = performance.now();
    const tick = (now: number) => {
      flingRaf.current = null;
      const dt = Math.min(64, now - prev); // clamp over a dropped-frame gap
      prev = now;
      const f = frameRef.current;
      if (!f) return;
      const cur = viewRef.current;
      const { view, overflowY } = panStepIn(f, cur, vx * dt, vy * dt);
      const moved = view.tx !== cur.tx || view.ty !== cur.ty;
      if (moved) setView(view);
      const unconsumed = overflowY ? chainScroll(overflowY) : 0;
      const decay = Math.exp(-dt / FLING_DECAY_TAU_MS);
      vx *= decay;
      vy *= decay;
      // A fully saturated vertical fling (nothing moved, nothing scrolled)
      // has hit the end of every surface — let it die there.
      if (!moved && Math.abs(unconsumed) >= Math.abs(vy * dt) - 0.5) vy = 0;
      if (Math.hypot(vx, vy) < FLING_MIN_KEEP) return;
      flingRaf.current = requestAnimationFrame(tick);
    };
    flingRaf.current = requestAnimationFrame(tick);
  }

  function midpoint() {
    const pts = [...pointers.current.values()];
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }
  function pointerDist() {
    const pts = [...pointers.current.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  function beginPan(clientX: number, clientY: number) {
    gesture.current = "pan";
    panLast.current = { x: clientX, y: clientY };
    scrollParents.current = scrollableAncestors(boxRef.current);
    setDragging(true);
  }

  function toggleZoomAt(clientX: number, clientY: number) {
    const f = frameRef.current;
    const r = stageRect();
    if (!f || !r) return;
    touched.current = true;
    if (viewRef.current.scale > f.minScale + 0.001) {
      setView(clampViewIn(f, { scale: f.minScale, tx: 0, ty: 0 }));
    } else {
      setView(zoomAboutIn(f, viewRef.current, clientX - r.left, clientY - r.top, DOUBLE_TAP_SCALE));
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    cancelFling(); // catching a fling stops it, like native scrolling
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pointers.current.size >= 2) {
      const f = frameRef.current;
      const r = stageRect();
      if (!f || !r) return;
      const m = midpoint();
      gesture.current = "pinch";
      touched.current = true;
      pinchStart.current = beginPinch(viewRef.current, f.box, m.x - r.left, m.y - r.top, pointerDist());
    } else {
      panMoved.current = 0;
      flingSamples.current = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
      beginPan(e.clientX, e.clientY);
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const f = frameRef.current;
    if (!f) return;
    if (gesture.current === "pinch") {
      if (pointers.current.size < 2) return;
      const r = stageRect();
      if (!r) return;
      const m = midpoint();
      setView(pinchViewIn(f, pinchStart.current, m.x - r.left, m.y - r.top, pointerDist()));
    } else if (gesture.current === "pan") {
      const cur = viewRef.current;
      const dx = e.clientX - panLast.current.x;
      const dy = e.clientY - panLast.current.y;
      panLast.current = { x: e.clientX, y: e.clientY };
      panMoved.current += Math.abs(dx) + Math.abs(dy);
      const now = performance.now();
      flingSamples.current.push({ t: now, x: e.clientX, y: e.clientY });
      while (flingSamples.current.length > 1 && now - flingSamples.current[0].t > FLING_SAMPLE_MS) {
        flingSamples.current.shift();
      }
      const { view, overflowY } = panStepIn(f, cur, dx, dy);
      // Skip the render when nothing moved (pure scroll-through on a fitted image).
      if (view.tx !== cur.tx || view.ty !== cur.ty || view.scale !== cur.scale) setView(view);
      if (overflowY) chainScroll(overflowY);
    }
  }

  function endPointer(e: React.PointerEvent) {
    const wasPan = gesture.current === "pan";
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = "none";
      setDragging(false);
      // Manual double-tap: with touch-action none, mobile engines don't
      // reliably synthesize dblclick — mouse keeps the native event below.
      if (wasPan && e.pointerType !== "mouse" && panMoved.current < TAP_MOVE_SLOP_PX) {
        const now = performance.now();
        const prev = lastTap.current;
        const isDouble =
          now - prev.t < DOUBLE_TAP_MS &&
          Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DOUBLE_TAP_SLOP_PX;
        lastTap.current = isDouble ? { t: 0, x: 0, y: 0 } : { t: now, x: e.clientX, y: e.clientY };
        if (isDouble) toggleZoomAt(e.clientX, e.clientY);
      } else if (wasPan && e.pointerType !== "mouse" && panMoved.current >= TAP_MOVE_SLOP_PX) {
        // Release velocity over the drag's last ~100ms → inertia. Touch/pen
        // only: a mouse drag has no fling convention.
        const s = flingSamples.current;
        const first = s[0];
        const dt = performance.now() - first.t;
        if (dt > 20) {
          const f = frameRef.current;
          const pannableX = f ? f.content.width * viewRef.current.scale > f.box.width + 0.5 : false;
          const vx = pannableX ? (e.clientX - first.x) / dt : 0;
          const vy = (e.clientY - first.y) / dt;
          if (Math.hypot(vx, vy) > FLING_MIN_START) startFling(vx, vy);
        }
      }
    } else if (pointers.current.size === 1 && gesture.current === "pinch") {
      // Lift one finger mid-pinch → continue as a pan from the survivor.
      const [pt] = [...pointers.current.values()];
      panMoved.current = TAP_MOVE_SLOP_PX; // a pinch is never a tap
      beginPan(pt.x, pt.y);
    }
  }

  const zoomByButton = (factor: number) => {
    cancelFling();
    const f = frameRef.current;
    if (!f) return;
    touched.current = true;
    setView(zoomByCenterIn(f, viewRef.current, factor));
  };

  // The preset a press will apply — also what the button's glyph/label show.
  const target = frame ? nextPreset(frame.box, frame.content, view.scale) : null;

  const applyPreset = () => {
    cancelFling();
    const f = frameRef.current;
    if (!f) return;
    touched.current = true;
    const p = nextPreset(f.box, f.content, viewRef.current.scale);
    // tx/ty 0 = top/left-aligned on an overflowing axis (a receipt reads from
    // the top), centered by the clamp on an axis the image fits.
    setView(clampViewIn(f, { scale: p.scale, tx: 0, ty: 0 }));
  };

  // Grab cursor only when there is actually something to drag.
  const pannable =
    frame != null &&
    (frame.content.width * view.scale > frame.box.width + 0.5 ||
      frame.content.height * view.scale > frame.box.height + 0.5);

  const ctrlBtn =
    "flex h-8 w-8 items-center justify-center rounded-full text-base leading-none text-white transition-colors hover:bg-white/20 disabled:opacity-40";

  return (
    <div className="relative">
      {/* The stage never scrolls, so the pill just floats over its corner. A
          fixed three-button layout: the preset button replaces the old
          appear/disappear reset, so −/+ never shift position. */}
      <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-full bg-stone-900/55 p-0.5 shadow backdrop-blur-sm">
        <button
          type="button"
          className={ctrlBtn}
          onClick={() => zoomByButton(1 / ZOOM_STEP)}
          disabled={!frame || view.scale <= frame.minScale + 0.001}
          aria-label={t("zoomOut")}
          title={t("zoomOut")}
        >
          −
        </button>
        <button
          type="button"
          className={ctrlBtn}
          onClick={() => zoomByButton(ZOOM_STEP)}
          disabled={!frame || view.scale >= frame.maxScale - 0.001}
          aria-label={t("zoomIn")}
          title={t("zoomIn")}
        >
          +
        </button>
        <button
          type="button"
          className={`${ctrlBtn} text-sm`}
          onClick={applyPreset}
          disabled={!target}
          aria-label={t(target?.kind ?? "fitImage")}
          title={t(target?.kind ?? "fitImage")}
          data-testid="pan-zoom-preset"
          data-preset={target?.kind}
        >
          {target ? PRESET_GLYPH[target.kind] : PRESET_GLYPH.fitImage}
        </button>
      </div>
      <div
        ref={boxRef}
        className={`touch-none select-none overflow-hidden ${
          pannable ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-default"
        } ${className ?? ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={(e) => toggleZoomAt(e.clientX, e.clientY)}
        data-testid="pan-zoom-stage"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={refit}
          className="block w-full will-change-transform"
          style={{
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
            transformOrigin: "0 0",
            // Hold the first paint until the contain fit is measured — no
            // flash of the unfitted image.
            visibility: frame ? undefined : "hidden",
            // iOS long-press save/copy callout fights the pan gesture.
            WebkitTouchCallout: "none",
          }}
          data-testid={imgTestId}
        />
      </div>
    </div>
  );
}
