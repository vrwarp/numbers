"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/use-api-error";

interface Crop {
  left: number;
  top: number;
  width: number;
  height: number;
}

const FULL_CROP: Crop = { left: 0, top: 0, width: 1, height: 1 };
const MIN_FRACTION = 0.08; // smallest crop-box side, as a fraction of the image
const MAX_STAGE_HEIGHT = 420;

type DragMode = "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function applyDrag(c: Crop, mode: DragMode, dx: number, dy: number): Crop {
  if (mode === "move") {
    return {
      ...c,
      left: clamp(c.left + dx, 0, 1 - c.width),
      top: clamp(c.top + dy, 0, 1 - c.height),
    };
  }
  let left = c.left;
  let top = c.top;
  let right = c.left + c.width;
  let bottom = c.top + c.height;
  if (mode.includes("w")) left = clamp(left + dx, 0, right - MIN_FRACTION);
  if (mode.includes("e")) right = clamp(right + dx, left + MIN_FRACTION, 1);
  if (mode.includes("n")) top = clamp(top + dy, 0, bottom - MIN_FRACTION);
  if (mode.includes("s")) bottom = clamp(bottom + dy, top + MIN_FRACTION, 1);
  return { left, top, width: right - left, height: bottom - top };
}

const HANDLES: { mode: DragMode; className: string }[] = [
  { mode: "nw", className: "absolute w-12 h-12 -left-6 -top-6 flex items-center justify-center cursor-nwse-resize" },
  { mode: "n", className: "absolute w-12 h-12 left-1/2 -top-6 -translate-x-1/2 flex items-center justify-center cursor-ns-resize" },
  { mode: "ne", className: "absolute w-12 h-12 -right-6 -top-6 flex items-center justify-center cursor-nesw-resize" },
  { mode: "e", className: "absolute w-12 h-12 -right-6 top-1/2 -translate-y-1/2 flex items-center justify-center cursor-ew-resize" },
  { mode: "se", className: "absolute w-12 h-12 -right-6 -bottom-6 flex items-center justify-center cursor-nwse-resize" },
  { mode: "s", className: "absolute w-12 h-12 left-1/2 -bottom-6 -translate-x-1/2 flex items-center justify-center cursor-ns-resize" },
  { mode: "sw", className: "absolute w-12 h-12 -left-6 -bottom-6 flex items-center justify-center cursor-nesw-resize" },
  { mode: "w", className: "absolute w-12 h-12 -left-6 top-1/2 -translate-y-1/2 flex items-center justify-center cursor-ew-resize" },
];

/**
 * Rotate / crop dialog for a receipt photo. Rotation previews via CSS; the
 * crop box is drawn on the ROTATED frame, so the fractions map 1:1 to what the
 * user saw — whether the transform is applied by the server (stored receipts)
 * or client-side on the local file (the pre-upload prepare step).
 */
export default function ReceiptImageEditor({
  receiptId,
  reimbursementId,
  src,
  onClose,
  onSaved,
  onApply,
}: {
  /** Stored-receipt mode: Save POSTs the transform to /api/receipts/[id]/edit.
   *  Omit in local mode (with onApply). */
  receiptId?: string;
  /** Claim the edit is made from, for the audit trail. Omit outside a claim
   *  (e.g. the Shoebox viewer). */
  reimbursementId?: string;
  src: string;
  onClose: () => void;
  onSaved: () => void;
  /** Local mode (pre-upload): Save hands the transform back instead of POSTing —
   *  the caller renders it client-side. Restore-original is unavailable (nothing
   *  is stored yet); a thrown error becomes the dialog's error message. */
  onApply?: (transform: { rotate: 0 | 90 | 180 | 270; crop?: Crop }) => Promise<void> | void;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const [stageMaxWidth, setStageMaxWidth] = useState(0);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [rotate, setRotate] = useState<0 | 90 | 180 | 270>(0);
  const [crop, setCrop] = useState<Crop>(FULL_CROP);
  const t = useTranslations("ImageEditor");
  const tCommon = useTranslations("Common");
  const apiError = useApiErrorMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasOriginal, setHasOriginal] = useState(false);
  // Staged (not yet saved) intent to reset to the pristine upload. While set,
  // the editor previews the original (read-only) and Save commits it; Cancel
  // discards it like any other unsaved change.
  const [restoring, setRestoring] = useState(false);
  const drag = useRef<{ mode: DragMode; x: number; y: number; crop: Crop } | null>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{
    initialDx: number;
    initialDy: number;
    initialMidpoint: { x: number; y: number };
    initialCrop: Crop;
  } | null>(null);

  // Preview the read-only original from its sidecar while a reset is staged.
  const displaySrc = restoring ? `/api/receipts/${receiptId}/file?original=1` : src;

  useEffect(() => {
    const measure = () => setStageMaxWidth(measureRef.current?.clientWidth ?? 0);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    if (!receiptId) return; // local mode: nothing stored, nothing to restore
    let alive = true;
    fetch(`/api/receipts/${receiptId}/edit`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && setHasOriginal(Boolean(d?.hasOriginal)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [receiptId]);

  const rotatedW = natural ? (rotate % 180 === 0 ? natural.w : natural.h) : 0;
  const rotatedH = natural ? (rotate % 180 === 0 ? natural.h : natural.w) : 0;
  const scale =
    natural && stageMaxWidth ? Math.min(stageMaxWidth / rotatedW, MAX_STAGE_HEIGHT / rotatedH) : 0;
  const dispW = Math.round(rotatedW * scale);
  const dispH = Math.round(rotatedH * scale);

  const isFullCrop = crop.width > 0.999 && crop.height > 0.999;
  const hasChanges = rotate !== 0 || !isFullCrop || restoring;

  function turn(delta: 90 | 270) {
    setRotate((r) => ((r + delta) % 360) as 0 | 90 | 180 | 270);
    setCrop(FULL_CROP); // the crop box is meaningless in the new frame
  }

  // Reset to the originally uploaded image. Nothing is written until Save: it
  // just clears the unsaved rotate/crop and, when an earlier edit exists,
  // stages a restore that previews the original in place.
  function reset() {
    setRotate(0);
    setCrop(FULL_CROP);
    if (hasOriginal && !restoring) {
      setRestoring(true);
      setNatural(null); // the original has the upload's dimensions — re-probe
    }
  }

  function startDrag(mode: DragMode) {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      drag.current = { mode, x: e.clientX, y: e.clientY, crop };
    };
  }

  function onStagePointerDown(e: React.PointerEvent) {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    if (pointers.current.size === 2) {
      drag.current = null;
      const pts = Array.from(pointers.current.values());
      // Track initial X and Y separation between the two touch points.
      // Use a 20px lower bound to prevent division by zero or extreme scaling sensitivity
      // when fingers start closely aligned along one of the axes.
      const dx = Math.max(20, Math.abs(pts[1].x - pts[0].x));
      const dy = Math.max(20, Math.abs(pts[1].y - pts[0].y));
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      pinch.current = {
        initialDx: dx,
        initialDy: dy,
        initialMidpoint: mid,
        initialCrop: { ...crop },
      };
    }
  }

  function onStagePointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2 && pinch.current && dispW && dispH) {
      const pts = Array.from(pointers.current.values());
      const dx = Math.abs(pts[1].x - pts[0].x);
      const dy = Math.abs(pts[1].y - pts[0].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };

      // Calculate horizontal and vertical scale factors independently (rubber-sheet stretch)
      const scaleX = dx / pinch.current.initialDx;
      const scaleY = dy / pinch.current.initialDy;

      // Calculate horizontal and vertical slide displacement based on midpoint shift
      const tx = (mid.x - pinch.current.initialMidpoint.x) / dispW;
      const ty = (mid.y - pinch.current.initialMidpoint.y) / dispH;

      const initCrop = pinch.current.initialCrop;
      const newWidth = clamp(initCrop.width * scaleX, MIN_FRACTION, 1);
      const newHeight = clamp(initCrop.height * scaleY, MIN_FRACTION, 1);

      const initCenter = {
        x: initCrop.left + initCrop.width / 2,
        y: initCrop.top + initCrop.height / 2,
      };
      const newCenter = {
        x: initCenter.x + tx,
        y: initCenter.y + ty,
      };

      let newLeft = newCenter.x - newWidth / 2;
      let newTop = newCenter.y - newHeight / 2;

      // Clamp coordinates to keep the crop box within stage bounds [0, 1]
      if (newLeft < 0) {
        newLeft = 0;
      } else if (newLeft + newWidth > 1) {
        newLeft = 1 - newWidth;
      }

      if (newTop < 0) {
        newTop = 0;
      } else if (newTop + newHeight > 1) {
        newTop = 1 - newHeight;
      }

      setCrop({
        left: newLeft,
        top: newTop,
        width: newWidth,
        height: newHeight,
      });
    } else if (pointers.current.size === 1 && drag.current && dispW && dispH) {
      const dx = (e.clientX - drag.current.x) / dispW;
      const dy = (e.clientY - drag.current.y) / dispH;
      setCrop(applyDrag(drag.current.crop, drag.current.mode, dx, dy));
    }
  }

  function onStagePointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    drag.current = null;
    pinch.current = null;
  }

  async function save() {
    setBusy(true);
    setError(null);
    if (onApply) {
      try {
        await onApply({ rotate, crop: isFullCrop ? undefined : crop });
      } catch (e) {
        setError(e instanceof Error ? e.message : t("editFailed"));
        setBusy(false);
        return;
      }
      onSaved();
      return;
    }
    const res = await fetch(`/api/receipts/${receiptId}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rotate,
        crop: isFullCrop ? undefined : crop,
        // With a reset staged, the server transforms the original instead of the
        // current file (rotate/crop still apply on top). undefined is dropped by
        // JSON.stringify; an empty string would 404.
        restore: restoring || undefined,
        reimbursementId: reimbursementId || undefined,
      }),
    });
    if (!res.ok) {
      setError(apiError(await res.json().catch(() => null), t("editFailed")));
      setBusy(false);
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal>
      <div className="card w-full max-w-2xl p-6">
        <h2 className="font-bold">{t("title")}</h2>
        <p className="mt-1 text-sm text-stone-500">
          {restoring ? t("introRestoring") : onApply ? t("introLocal") : t("introStored")}
        </p>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          <button className="btn-secondary flex h-12 w-12 items-center justify-center rounded-full text-lg" onClick={() => turn(270)} disabled={busy} data-testid="rotate-left" aria-label={t("rotateLeft")} title={t("rotateLeft")}>
            ↺
          </button>
          <button className="btn-secondary flex h-12 w-12 items-center justify-center rounded-full text-lg" onClick={() => turn(90)} disabled={busy} data-testid="rotate-right" aria-label={t("rotateRight")} title={t("rotateRight")}>
            ↻
          </button>
          <button
            className="btn-secondary flex h-12 items-center justify-center rounded-full px-6 text-sm font-semibold"
            onClick={reset}
            disabled={busy || (!hasChanges && !hasOriginal)}
            data-testid="crop-reset"
            title={t("resetTitle")}
          >
            {t("reset")}
          </button>
        </div>

        <div ref={measureRef} className="mt-4 w-full">
          {/* Hidden probe: we need the natural dimensions before laying out the stage. */}
          {!natural && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={displaySrc}
              alt=""
              className="hidden"
              onLoad={(e) =>
                setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
              }
              onError={() => setError(t("loadFailed"))}
            />
          )}
          {natural && dispW > 0 ? (
            <div
              className="relative mx-auto touch-none select-none overflow-hidden rounded bg-stone-900"
              style={{ width: dispW, height: dispH }}
              onPointerDown={onStagePointerDown}
              onPointerMove={onStagePointerMove}
              onPointerUp={onStagePointerUp}
              onPointerCancel={onStagePointerUp}
              data-testid="image-editor-stage"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={displaySrc}
                alt={t("editedAlt")}
                draggable={false}
                className="absolute left-1/2 top-1/2 max-w-none"
                style={{
                  width: natural.w * scale,
                  height: natural.h * scale,
                  transform: `translate(-50%, -50%) rotate(${rotate}deg)`,
                }}
              />
              <div
                className="absolute cursor-move border-2 border-indigo-400"
                style={{
                  left: crop.left * dispW,
                  top: crop.top * dispH,
                  width: crop.width * dispW,
                  height: crop.height * dispH,
                  boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)",
                }}
                onPointerDown={(e) => {
                  if (!(e.target as HTMLElement).closest("[data-handle]")) {
                    startDrag("move")(e);
                  }
                }}
                data-testid="crop-box"
              >
                {HANDLES.map((h) => (
                  <span
                    key={h.mode}
                    className={h.className}
                    data-handle={h.mode}
                    onPointerDown={startDrag(h.mode)}
                  >
                    <span className="h-3 w-3 rounded-full border border-indigo-600 bg-white shadow-sm" />
                  </span>
                ))}
              </div>
            </div>
          ) : (
            !error && <p className="py-10 text-center text-sm text-stone-500">{t("loadingImage")}</p>
          )}
        </div>

        {error && (
          <p className="mt-3 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}

        <div className="mt-6 flex items-center justify-center gap-3">
          <button className="btn-secondary flex h-12 items-center justify-center rounded-full px-8 text-sm font-semibold" onClick={onClose} disabled={busy} data-testid="image-editor-cancel">
            {tCommon("cancel")}
          </button>
          <button
            className="btn-primary flex h-12 items-center justify-center rounded-full px-8 text-sm font-semibold"
            onClick={save}
            disabled={busy || !hasChanges}
            title={!hasChanges ? t("saveDisabledTitle") : undefined}
            data-testid="image-editor-save"
          >
            {busy ? tCommon("saving") : tCommon("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
