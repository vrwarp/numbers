"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  beginPinch,
  isIdentity,
  panStep,
  pinchView,
  zoomAbout,
  zoomByCenter,
  ZOOM_STEP,
  type PinchStart,
  type View,
} from "@/lib/esign/viewport";

/**
 * Inline zoomable receipt image (review screen). Reuses the e-sign signing
 * surface's viewport math (src/lib/esign/viewport.ts) and its gesture
 * contract: the surface owns touch (touch-action: none, required for the
 * custom pinch), so a one-finger drag pans the zoomed image and chains
 * whatever the pan can't absorb into the surrounding scrollers — at 100%
 * the whole drag scrolls through the clamped receipt viewport and on into
 * the page, and a zoomed pan keeps scrolling once it hits the top/bottom
 * edge. Without this, the image's nested overscroll-contain scroller
 * swallowed touch scrolling dead on mobile.
 *
 * Unlike the signing box, the "box" here is the image's full layout size
 * (often taller than the visible clamp window) — the viewport math is
 * origin-relative, so it holds unchanged.
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

export default function PanZoomImage({
  src,
  alt,
  imgTestId,
}: {
  src: string;
  alt: string;
  imgTestId?: string;
}) {
  // Zoom strings already exist for the full-screen viewer — same verbs here.
  const t = useTranslations("Viewer");
  const [view, setViewState] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  const setView = (next: View) => {
    viewRef.current = next;
    setViewState(next);
  };

  const boxRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture>("none");
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const panLast = useRef({ x: 0, y: 0 });
  const panMoved = useRef(0);
  const scrollParents = useRef<Element[]>([]);
  const pinchStart = useRef<PinchStart>({ dist: 0, scale: 1, cx: 0, cy: 0 });
  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  const downAt = useRef({ x: 0, y: 0 });
  const flingSamples = useRef<{ t: number; x: number; y: number }[]>([]);
  const flingRaf = useRef<number | null>(null);

  const box = () => {
    const r = boxRef.current?.getBoundingClientRect();
    return r ? { width: r.width, height: r.height, left: r.left, top: r.top } : null;
  };

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
   *  frame so the fling crosses the image/scroller/page boundaries just like
   *  the finger did. Stops when it slows down or everything is saturated. */
  function startFling(vx0: number, vy0: number) {
    let vx = vx0;
    let vy = vy0;
    let prev = performance.now();
    const tick = (now: number) => {
      flingRaf.current = null;
      const dt = Math.min(64, now - prev); // clamp over a dropped-frame gap
      prev = now;
      const b = box();
      if (!b) return;
      const cur = viewRef.current;
      const { view, overflowY } = panStep(cur, b, vx * dt, vy * dt);
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
  }

  function toggleZoomAt(clientX: number, clientY: number) {
    const b = box();
    if (!b) return;
    if (viewRef.current.scale > 1) setView({ scale: 1, tx: 0, ty: 0 });
    else setView(zoomAbout(viewRef.current, b, clientX - b.left, clientY - b.top, DOUBLE_TAP_SCALE));
  }

  function onPointerDown(e: React.PointerEvent) {
    cancelFling(); // catching a fling stops it, like native scrolling
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pointers.current.size >= 2) {
      const b = box();
      if (!b) return;
      const m = midpoint();
      gesture.current = "pinch";
      pinchStart.current = beginPinch(viewRef.current, b, m.x - b.left, m.y - b.top, pointerDist());
    } else {
      downAt.current = { x: e.clientX, y: e.clientY };
      panMoved.current = 0;
      flingSamples.current = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
      beginPan(e.clientX, e.clientY);
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture.current === "pinch") {
      if (pointers.current.size < 2) return;
      const b = box();
      if (!b) return;
      const m = midpoint();
      setView(pinchView(pinchStart.current, b, m.x - b.left, m.y - b.top, pointerDist()));
    } else if (gesture.current === "pan") {
      const b = box();
      if (!b) return;
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
      const { view, overflowY } = panStep(cur, b, dx, dy);
      // Skip the render when nothing moved (pure scroll at 100%).
      if (view.tx !== cur.tx || view.ty !== cur.ty || view.scale !== cur.scale) setView(view);
      if (overflowY) chainScroll(overflowY);
    }
  }

  function endPointer(e: React.PointerEvent) {
    const wasPan = gesture.current === "pan";
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = "none";
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
          const vx = viewRef.current.scale > 1 ? (e.clientX - first.x) / dt : 0;
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
    const b = box();
    if (b) setView(zoomByCenter(viewRef.current, b, factor));
  };

  const ctrlBtn =
    "flex h-8 w-8 items-center justify-center rounded-full text-base leading-none text-white transition-colors hover:bg-white/20 disabled:opacity-40";

  return (
    <div className="relative">
      {/* Sticky inside the clamped receipt scroller, so the controls stay in
          view while a tall receipt scrolls under them. h-0 keeps them out of
          the image's layout. */}
      {/* items-start: the h-0 strip would otherwise stretch the pill to zero
          height (flex default), collapsing it into a bar. */}
      <div className="pointer-events-none sticky top-2 z-10 flex h-0 items-start justify-end pr-2">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-stone-900/55 p-0.5 shadow backdrop-blur-sm">
          <button
            type="button"
            className={ctrlBtn}
            onClick={() => zoomByButton(1 / ZOOM_STEP)}
            disabled={view.scale <= 1}
            aria-label={t("zoomOut")}
            title={t("zoomOut")}
          >
            −
          </button>
          <button
            type="button"
            className={ctrlBtn}
            onClick={() => zoomByButton(ZOOM_STEP)}
            aria-label={t("zoomIn")}
            title={t("zoomIn")}
          >
            +
          </button>
          {!isIdentity(view) && (
            <button
              type="button"
              className={ctrlBtn}
              onClick={() => {
                cancelFling();
                setView({ scale: 1, tx: 0, ty: 0 });
              }}
              aria-label={t("resetZoom")}
              title={t("resetZoom")}
              data-testid="pan-zoom-reset"
            >
              ⤢
            </button>
          )}
        </div>
      </div>
      <div
        ref={boxRef}
        className="touch-none select-none overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={(e) => toggleZoomAt(e.clientX, e.clientY)}
        data-testid="pan-zoom-stage"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="w-full will-change-transform"
          style={{
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
            transformOrigin: "0 0",
            // iOS long-press save/copy callout fights the pan gesture.
            WebkitTouchCallout: "none",
          }}
          data-testid={imgTestId}
        />
      </div>
    </div>
  );
}
