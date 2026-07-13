"use client";

/**
 * Hold-to-stamp signing surface (docs/ESIGN_DESIGN.md click-to-stamp): shows
 * the actual document with a "Hold to sign" placeholder ON the signature line.
 * Nothing is stamped until the signer presses and HOLDS the tab — a deliberate
 * long-press (with a visible progress ring) is the required affirmative act
 * (good UETA evidence) and, unlike a bare tap, it never collides with the
 * pan/zoom/drag gestures that share this surface. Keyboard users get the same
 * act via Enter/Space on the focused tab.
 *
 * The surface is pinch-to-zoom and pan (plus explicit zoom buttons for
 * mouse-only devices); once the signature is placed it can be dragged to
 * reposition. Because signing is a hold rather than a tap, a plain
 * touch/click-and-drag pans (or drags the stamp) without accidentally signing.
 *
 * The page image is rendered from the EXACT bytes passed in (client-side
 * pdf.js), never a server raster — so what you place your signature on is
 * provably the document being signed. Emits a page-normalized placement
 * (bottom-left origin) that the browser overlay and the server's pdf-lib
 * stamp agree on exactly, or null while unplaced. Zoom/pan is a pure CSS
 * transform on the preview and never touches the emitted ratios.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { renderFirstPage, type RenderedPage } from "@/lib/esign/pdfjs-client";
import { clampPlacement, fitWidthToHeight, roundPlacement, type FieldAnchor, type SignaturePlacement } from "@/lib/esign/placement";
import {
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_STEP,
  beginPinch as beginPinchView,
  clampView,
  isIdentity,
  panView,
  pinchView,
  zoomByCenter,
  type PinchStart,
  type View,
} from "@/lib/esign/viewport";

/**
 * Cap the stamped signature to roughly the height of the form's printed-name
 * line (~18pt on the 612×792 CFCC template, matching the "Name (Please print)"
 * field). Without this, a compact mark scaled to the full signature column
 * blows up vertically — a near-square doodle became a ~2-inch-tall blob and
 * even a real signature overran the line.
 */
const SIG_MAX_HEIGHT_PT = 18;

/** How long the sign tab must be held before the signature stamps. */
const HOLD_MS = 550;
/** Pointer travel (px) that aborts an in-progress hold — it was a pan, not a press. */
const HOLD_CANCEL_PX = 10;

type Gesture = "none" | "hold" | "dragSig" | "pan" | "pinch";

/** A value that fills a named form field on signing — the printed name and date
 *  the certificate route stamps, previewed in place so the signer sees the whole
 *  block complete, not just the signature. */
export interface TextStamp {
  key: string;
  text: string;
  field: FieldAnchor;
}

export default function DocumentSignField({
  bytes,
  signatureImage,
  anchor,
  onChange,
  textStamps,
}: {
  bytes: ArrayBuffer;
  signatureImage: string;
  anchor: SignaturePlacement;
  onChange: (placement: SignaturePlacement | null) => void;
  /** Rendered once the signature is placed (bottom-left origin, page-relative);
   *  omitted for the requestor, whose name/date are already baked into the
   *  packet bytes being previewed. */
  textStamps?: TextStamp[];
}) {
  const t = useTranslations("Esign");
  const [page, setPage] = useState<RenderedPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState(false);
  const [placement, setPlacement] = useState<SignaturePlacement>(anchor);
  const [imgAspect, setImgAspect] = useState(0.35); // naturalH / naturalW
  const [view, setViewState] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const [holdProgress, setHoldProgress] = useState(0);

  const boxRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLImageElement>(null);

  // Mutable gesture state kept in refs so pointer handlers never read a stale
  // closure between renders.
  const viewRef = useRef(view);
  const gesture = useRef<Gesture>("none");
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const holdRaf = useRef<number | null>(null);
  const holdStart = useRef({ x: 0, y: 0, t: 0 });
  const panStart = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const pinchStart = useRef<PinchStart>({ dist: 0, scale: 1, cx: 0, cy: 0 });

  const setView = useCallback((next: View) => {
    viewRef.current = next;
    setViewState(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    renderFirstPage(bytes, 820)
      .then((p) => !cancelled && setPage(p))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Could not open the document"));
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setImgAspect(img.naturalHeight / Math.max(1, img.naturalWidth));
    img.src = signatureImage;
  }, [signatureImage]);

  // Aspect as a fraction of PAGE height (for clamping the stamp inside the page).
  const heightRatioPerWidth = useMemo(
    () => (page ? imgAspect * (page.widthPt / page.heightPt) : imgAspect),
    [imgAspect, page]
  );

  const commit = useCallback(
    (p: SignaturePlacement) => {
      // Fit the stamp to the signature line's height before clamping: scaling a
      // compact signature to the full column width would balloon it well past
      // the line, so cap the width by a target height first.
      const maxHeightRatio = page ? SIG_MAX_HEIGHT_PT / page.heightPt : 1;
      const widthRatio = fitWidthToHeight(p.widthRatio, heightRatioPerWidth, maxHeightRatio);
      const clamped = clampPlacement({ ...p, widthRatio }, heightRatioPerWidth);
      setPlacement(clamped);
      onChange(roundPlacement(clamped));
    },
    [heightRatioPerWidth, onChange, page]
  );

  // Re-fit if the signature image's true aspect resolves after it's placed —
  // the initial aspect is a guess until the PNG loads, and committing against a
  // stale guess would leave the stamp mis-sized.
  const placementRef = useRef(placement);
  placementRef.current = placement;
  useEffect(() => {
    if (placed) commit(placementRef.current);
  }, [placed, commit]);

  /** The required affirmative act: holding the sign-here tab stamps the
   *  signature on the line. Until then the parent holds no placement and
   *  the sign button stays disabled. */
  const placeAtAnchor = useCallback(() => {
    setPlaced(true);
    commit(anchor);
  }, [anchor, commit]);

  function unplace() {
    setPlaced(false);
    gesture.current = "none";
    setPlacement(anchor);
    onChange(null);
  }

  // Map a client point to a page-normalized placement, using the page image's
  // on-screen rect — which already reflects the zoom/pan transform, so ratios
  // stay correct at any scale.
  const moveTo = useCallback(
    (clientX: number, clientY: number) => {
      const rect = pageRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cur = placementRef.current;
      const stampWpx = cur.widthRatio * rect.width;
      // Drop point = bottom-center of the stamp.
      const xRatio = (clientX - rect.left - stampWpx / 2) / rect.width;
      const yRatio = (rect.height - (clientY - rect.top)) / rect.height;
      commit({ ...cur, xRatio, yRatio });
    },
    [commit]
  );

  // ----- zoom / pan (math lives in @/lib/esign/viewport) -----------------

  const boxSize = useCallback(() => {
    const r = boxRef.current?.getBoundingClientRect();
    return r ? { width: r.width, height: r.height } : null;
  }, []);

  const zoomByButton = useCallback(
    (factor: number) => {
      const box = boxSize();
      if (box) setView(zoomByCenter(viewRef.current, box, factor));
    },
    [boxSize, setView]
  );

  const resetZoom = useCallback(() => setView({ scale: 1, tx: 0, ty: 0 }), [setView]);

  // ----- long-press to sign ---------------------------------------------

  const cancelHold = useCallback(() => {
    if (holdRaf.current != null) cancelAnimationFrame(holdRaf.current);
    holdRaf.current = null;
    setHoldProgress(0);
    if (gesture.current === "hold") gesture.current = "none";
  }, []);

  const startHold = useCallback(
    (clientX: number, clientY: number) => {
      gesture.current = "hold";
      holdStart.current = { x: clientX, y: clientY, t: performance.now() };
      const tick = () => {
        const elapsed = performance.now() - holdStart.current.t;
        const p = Math.min(1, elapsed / HOLD_MS);
        setHoldProgress(p);
        if (p >= 1) {
          cancelHold();
          placeAtAnchor();
          return;
        }
        holdRaf.current = requestAnimationFrame(tick);
      };
      holdRaf.current = requestAnimationFrame(tick);
    },
    [cancelHold, placeAtAnchor]
  );

  useEffect(() => () => cancelHold(), [cancelHold]);

  // ----- unified pointer routing ----------------------------------------

  function midpoint() {
    const pts = [...pointers.current.values()];
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }
  function pointerDist() {
    const pts = [...pointers.current.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  function beginPinch() {
    cancelHold();
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const m = midpoint();
    gesture.current = "pinch";
    pinchStart.current = beginPinchView(
      viewRef.current,
      { width: box.width, height: box.height },
      m.x - box.left,
      m.y - box.top,
      pointerDist()
    );
  }

  function onPointerDown(e: React.PointerEvent) {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);

    if (pointers.current.size >= 2) {
      beginPinch();
      return;
    }

    const role = (e.target as HTMLElement).closest("[data-role]")?.getAttribute("data-role");
    const v = viewRef.current;

    if (placed) {
      if (v.scale > 1 && role !== "stamp") {
        gesture.current = "pan";
        panStart.current = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty };
      } else {
        gesture.current = "dragSig";
        moveTo(e.clientX, e.clientY);
      }
      return;
    }

    if (role === "sign-tab") {
      startHold(e.clientX, e.clientY);
    } else if (v.scale > 1) {
      gesture.current = "pan";
      panStart.current = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty };
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    switch (gesture.current) {
      case "pinch": {
        if (pointers.current.size < 2) return;
        const box = boxRef.current?.getBoundingClientRect();
        if (!box) return;
        const m = midpoint();
        setView(
          pinchView(
            pinchStart.current,
            { width: box.width, height: box.height },
            m.x - box.left,
            m.y - box.top,
            pointerDist()
          )
        );
        break;
      }
      case "hold": {
        const dx = e.clientX - holdStart.current.x;
        const dy = e.clientY - holdStart.current.y;
        if (Math.hypot(dx, dy) > HOLD_CANCEL_PX) cancelHold();
        break;
      }
      case "dragSig":
        moveTo(e.clientX, e.clientY);
        break;
      case "pan": {
        const box = boxSize();
        if (box) setView(panView(viewRef.current, box, panStart.current, e.clientX, e.clientY));
        break;
      }
    }
  }

  function endPointer(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (gesture.current === "hold") cancelHold();
    if (pointers.current.size === 0) {
      gesture.current = "none";
    } else if (pointers.current.size === 1 && gesture.current === "pinch") {
      // Lift one finger mid-pinch → continue as a pan from the survivor.
      const [pt] = [...pointers.current.values()];
      const v = viewRef.current;
      gesture.current = "pan";
      panStart.current = { x: pt.x, y: pt.y, tx: v.tx, ty: v.ty };
    }
  }

  if (error) {
    return (
      <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
        {t("couldNotOpenDoc", { message: error })}
      </div>
    );
  }
  if (!page) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-stone-200 text-sm text-stone-400">
        {t("openingDoc")}
      </div>
    );
  }

  // Overlay geometry (CSS %, so it scales with the responsive image).
  const leftPct = placement.xRatio * 100;
  const widthPct = placement.widthRatio * 100;
  const stampHeightFracOfHeight = placement.widthRatio * heightRatioPerWidth;
  const topPct = (1 - placement.yRatio - stampHeightFracOfHeight) * 100;

  const holding = holdProgress > 0;
  // Progress-ring geometry (circle circumference for stroke-dashoffset sweep).
  const RING_R = 15;
  const RING_C = 2 * Math.PI * RING_R;

  return (
    <div className="space-y-2">
      <p className="text-sm text-stone-600">{placed ? t("signedDragHint") : t("holdTabHint")}</p>
      <div
        ref={boxRef}
        className="relative w-full touch-none select-none overflow-hidden rounded-lg border border-stone-300 bg-white"
        // containerType makes the box a query container so the overlaid
        // name/date text can size in cqw — a fraction of the page width that
        // the CSS zoom transform then scales, staying crisp at any zoom.
        style={{ aspectRatio: `${page.widthPx} / ${page.heightPx}`, containerType: "inline-size" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        data-testid="document-sign-field"
      >
        <div
          className="absolute left-0 top-0 w-full origin-top-left"
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
          data-testid="sign-viewport-content"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={pageRef}
            src={page.dataUrl}
            alt={t("docAlt")}
            className="pointer-events-none block w-full"
          />
          {placed ? (
            <div
              data-role="stamp"
              className="absolute cursor-grab active:cursor-grabbing"
              style={{ left: `${leftPct}%`, top: `${topPct}%`, width: `${widthPct}%` }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={signatureImage} alt={t("signatureAlt")} className="pointer-events-none block w-full" />
            </div>
          ) : (
            <button
              type="button"
              data-role="sign-tab"
              // Keyboard activation (Enter/Space → click with detail 0) signs
              // immediately; pointer clicks (detail ≥ 1) are handled by the
              // hold gesture instead, so a quick tap never signs.
              onClick={(e) => {
                if (e.detail === 0) placeAtAnchor();
              }}
              className={`absolute flex items-center justify-center gap-1 overflow-hidden rounded-md border-2 border-amber-500 bg-amber-300/90 py-1.5 text-xs font-bold text-amber-950 shadow-md ${
                holding ? "" : "animate-pulse motion-reduce:animate-none"
              }`}
              style={{
                left: `${anchor.xRatio * 100}%`,
                bottom: `${anchor.yRatio * 100}%`,
                width: `${anchor.widthRatio * 100}%`,
              }}
              data-testid="tap-to-sign"
            >
              {holding && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 left-0 bg-amber-400/70"
                  style={{ width: `${holdProgress * 100}%` }}
                />
              )}
              {holding ? (
                <span className="relative flex items-center gap-1.5">
                  <svg viewBox="0 0 36 36" className="h-4 w-4" aria-hidden>
                    <circle cx="18" cy="18" r={RING_R} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
                    <circle
                      cx="18"
                      cy="18"
                      r={RING_R}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="4"
                      strokeLinecap="round"
                      strokeDasharray={RING_C}
                      strokeDashoffset={RING_C * (1 - holdProgress)}
                      transform="rotate(-90 18 18)"
                    />
                  </svg>
                  {t("holdingToSign")}
                </span>
              ) : (
                <span className="relative">{t("tapToSign")}</span>
              )}
            </button>
          )}
          {/* Printed name + date land with the signature: the certificate route
              stamps these same values, so previewing them fills the whole
              "Approved by" block, not just the signature line. Sized in cqw
              (fraction of page width) so they scale with the zoom transform. */}
          {placed &&
            textStamps?.map((s) =>
              s.text.trim() ? (
                <span
                  key={s.key}
                  className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap text-center font-medium leading-none text-stone-900"
                  style={{
                    // Centered in the field (translate-x-1/2 off its midpoint),
                    // matching the centered stamp the approved copy bakes in.
                    left: `${(s.field.xRatio + s.field.widthRatio / 2) * 100}%`,
                    bottom: `${s.field.yRatio * 100}%`,
                    // Match the certificate route's fixed 10pt stamp: 1cqw is 1%
                    // of page width, and the zoom transform scales it from there.
                    fontSize: `${(10 / page.widthPt) * 100}cqw`,
                    paddingBottom: `${(2 / page.widthPt) * 100}cqw`,
                  }}
                  data-testid={`sign-fill-${s.key}`}
                >
                  {s.text}
                </span>
              ) : null
            )}
        </div>

        {/* Zoom controls for mouse-only surfaces. Live in the viewport (not the
            transformed content) so they stay pinned and unscaled; their own
            pointer-down is stopped so it never starts a pan. */}
        <div
          className="absolute right-2 top-2 flex flex-col overflow-hidden rounded-lg border border-stone-300 bg-white/90 shadow-sm backdrop-blur"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center text-lg text-stone-700 hover:bg-stone-100 disabled:text-stone-300"
            onClick={() => zoomByButton(ZOOM_STEP)}
            disabled={view.scale >= MAX_SCALE}
            aria-label={t("zoomIn")}
            title={t("zoomIn")}
            data-testid="zoom-in"
          >
            +
          </button>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center border-y border-stone-200 text-xs text-stone-700 hover:bg-stone-100 disabled:text-stone-300"
            onClick={resetZoom}
            disabled={isIdentity(view)}
            aria-label={t("zoomReset")}
            title={t("zoomReset")}
            data-testid="zoom-reset"
          >
            {Math.round(view.scale * 100)}%
          </button>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center text-lg text-stone-700 hover:bg-stone-100 disabled:text-stone-300"
            onClick={() => zoomByButton(1 / ZOOM_STEP)}
            disabled={view.scale <= MIN_SCALE}
            aria-label={t("zoomOut")}
            title={t("zoomOut")}
            data-testid="zoom-out"
          >
            −
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between text-xs text-stone-400">
        {placed ? (
          <>
            <span>{t("dragFineTune")}</span>
            <button
              type="button"
              className="text-indigo-600 underline"
              onClick={unplace}
              data-testid="remove-signature"
            >
              {t("removeSignature")}
            </button>
          </>
        ) : (
          <span>{t("appearsAfterTap")}</span>
        )}
      </div>
    </div>
  );
}
