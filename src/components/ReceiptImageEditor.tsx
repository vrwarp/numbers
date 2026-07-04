"use client";

import { useEffect, useRef, useState } from "react";

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
  { mode: "nw", className: "-left-1.5 -top-1.5 cursor-nwse-resize" },
  { mode: "n", className: "left-1/2 -top-1.5 -translate-x-1/2 cursor-ns-resize" },
  { mode: "ne", className: "-right-1.5 -top-1.5 cursor-nesw-resize" },
  { mode: "e", className: "-right-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize" },
  { mode: "se", className: "-right-1.5 -bottom-1.5 cursor-nwse-resize" },
  { mode: "s", className: "left-1/2 -bottom-1.5 -translate-x-1/2 cursor-ns-resize" },
  { mode: "sw", className: "-left-1.5 -bottom-1.5 cursor-nesw-resize" },
  { mode: "w", className: "-left-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize" },
];

/**
 * Rotate / crop dialog for a receipt photo. Rotation previews via CSS; the
 * crop box is drawn on the ROTATED frame, so the fractions sent to the server
 * (which also rotates first) map 1:1 to what the user saw.
 */
export default function ReceiptImageEditor({
  receiptId,
  reimbursementId,
  src,
  onClose,
  onSaved,
}: {
  receiptId: string;
  /** Claim the edit is made from, for the audit trail. Omit outside a claim
   *  (e.g. the post-upload describe step or the Shoebox viewer). */
  reimbursementId?: string;
  src: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const [stageMaxWidth, setStageMaxWidth] = useState(0);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [rotate, setRotate] = useState<0 | 90 | 180 | 270>(0);
  const [crop, setCrop] = useState<Crop>(FULL_CROP);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasOriginal, setHasOriginal] = useState(false);
  // Bumped to cache-bust the <img> after a server-side restore swaps the stored
  // file for the original; `replaced` tells the parent to refresh on close.
  const [imgVersion, setImgVersion] = useState(0);
  const [replaced, setReplaced] = useState(false);
  const drag = useRef<{ mode: DragMode; x: number; y: number; crop: Crop } | null>(null);

  const displaySrc = imgVersion === 0 ? src : `${src}${src.includes("?") ? "&" : "?"}v=${imgVersion}`;

  useEffect(() => {
    const measure = () => setStageMaxWidth(measureRef.current?.clientWidth ?? 0);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
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
  const hasChanges = rotate !== 0 || !isFullCrop;

  function turn(delta: 90 | 270) {
    setRotate((r) => ((r + delta) % 360) as 0 | 90 | 180 | 270);
    setCrop(FULL_CROP); // the crop box is meaningless in the new frame
  }

  // Reset to the originally uploaded image. Always clears the unsaved
  // rotate/crop; if an earlier edit was saved, it also swaps the stored file
  // back to the original and reloads it inline — the dialog stays open, so it
  // feels the same whether or not there was a prior edit.
  function reset() {
    setRotate(0);
    setCrop(FULL_CROP);
    if (hasOriginal) void restoreOriginal();
  }

  function startDrag(mode: DragMode) {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { mode, x: e.clientX, y: e.clientY, crop };
    };
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current || !dispW || !dispH) return;
    const dx = (e.clientX - drag.current.x) / dispW;
    const dy = (e.clientY - drag.current.y) / dispH;
    setCrop(applyDrag(drag.current.crop, drag.current.mode, dx, dy));
  }

  function endDrag() {
    drag.current = null;
  }

  async function save() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/receipts/${receiptId}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rotate,
        crop: isFullCrop ? undefined : crop,
        // undefined is dropped by JSON.stringify; an empty string would 404.
        reimbursementId: reimbursementId || undefined,
      }),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? "Image edit failed");
      setBusy(false);
      return;
    }
    onSaved();
  }

  async function restoreOriginal() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/receipts/${receiptId}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restore: true, reimbursementId: reimbursementId || undefined }),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? "Restore failed");
      setBusy(false);
      return;
    }
    // Swap the restored original in place: re-probe its (upload) dimensions and
    // cache-bust the <img> so the browser fetches the new bytes.
    setReplaced(true);
    setNatural(null);
    setImgVersion((v) => v + 1);
    setBusy(false);
  }

  function close() {
    // A restore already rewrote the stored file; onSaved lets the parent
    // refresh its thumbnail. Otherwise nothing changed — just dismiss.
    if (replaced) onSaved();
    else onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal>
      <div className="card w-full max-w-2xl p-6">
        <h2 className="font-bold">Rotate &amp; crop receipt</h2>
        <p className="mt-1 text-sm text-stone-500">
          Straighten the photo and drag the box to trim away the background. Saving replaces the
          stored image.
        </p>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <button className="btn-secondary" onClick={() => turn(270)} disabled={busy} data-testid="rotate-left" aria-label="Rotate left" title="Rotate left">
            ↺
          </button>
          <button className="btn-secondary" onClick={() => turn(90)} disabled={busy} data-testid="rotate-right" aria-label="Rotate right" title="Rotate right">
            ↻
          </button>
          <button
            className="btn-secondary"
            onClick={reset}
            disabled={busy || (!hasChanges && !hasOriginal)}
            data-testid="crop-reset"
            title="Reset to the originally uploaded image"
          >
            Reset
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
              onError={() => setError("Could not load the receipt image")}
            />
          )}
          {natural && dispW > 0 ? (
            <div
              className="relative mx-auto touch-none select-none overflow-hidden rounded bg-stone-900"
              style={{ width: dispW, height: dispH }}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              data-testid="image-editor-stage"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={displaySrc}
                alt="Receipt being edited"
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
                onPointerDown={startDrag("move")}
                data-testid="crop-box"
              >
                {HANDLES.map((h) => (
                  <span
                    key={h.mode}
                    className={`absolute h-3 w-3 rounded-sm border border-indigo-600 bg-white ${h.className}`}
                    onPointerDown={startDrag(h.mode)}
                  />
                ))}
              </div>
            </div>
          ) : (
            !error && <p className="py-10 text-center text-sm text-stone-500">Loading image…</p>
          )}
        </div>

        {error && (
          <p className="mt-3 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center justify-center gap-2">
          <button className="btn-secondary" onClick={close} disabled={busy} data-testid="image-editor-cancel">
            {replaced ? "Done" : "Cancel"}
          </button>
          <button
            className="btn-primary"
            onClick={save}
            disabled={busy || !hasChanges}
            title={!hasChanges ? "Rotate or draw a crop first" : undefined}
            data-testid="image-editor-save"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
