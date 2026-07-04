"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReceiptImageEditor from "./ReceiptImageEditor";
import { usePdfPreviewManifest, pdfPreviewPageUrl } from "./PdfReceiptPreview";

interface ViewerReceipt {
  id: string;
  originalName: string;
  mimeType: string;
  status: string;
}

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Full-screen viewer for a single receipt. Images get custom zoom/pan
 * (wheel, pinch, drag, double-tap, buttons); PDFs show their per-page raster
 * previews as a natively scrollable column with button zoom (width scaling).
 * Image zoom math keeps the point under the cursor/pinch-midpoint fixed,
 * treating the container centre as the transform origin.
 */
export default function ReceiptViewer({
  receipt,
  onClose,
  onEdited,
}: {
  receipt: ViewerReceipt;
  onClose: () => void;
  onEdited?: () => void;
}) {
  const isPdf = receipt.mimeType === "application/pdf";
  // Only unassigned photos can be rotated/cropped: the edit route overwrites
  // the stored file and refuses PDFs and receipts frozen on a generated claim.
  const canEdit = receipt.mimeType.startsWith("image/") && receipt.status === "unassigned";

  // Bumped after each save so the <img> re-fetches the overwritten file.
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const src = `/api/receipts/${receipt.id}/file${version ? `?v=${version}` : ""}`;
  // PDFs display as server-rasterized page images (mobile browsers won't render
  // an embedded PDF); the ↗ link below still opens the real PDF via `src`.
  const pdfPreview = usePdfPreviewManifest(isPdf ? receipt.id : "");

  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;

  const stageRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  const reset = useCallback(() => setView({ scale: 1, x: 0, y: 0 }), []);

  // Zoom to `nextScale`, keeping the client point (clientX, clientY) fixed.
  const zoomAt = useCallback((nextScale: number, clientX: number, clientY: number) => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = clientX - (rect.left + rect.width / 2);
    const cy = clientY - (rect.top + rect.height / 2);
    const ns = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    if (ns <= MIN_SCALE) {
      setView({ scale: 1, x: 0, y: 0 });
      return;
    }
    const { scale, x, y } = viewRef.current;
    setView({
      scale: ns,
      x: cx - (ns * (cx - x)) / scale,
      y: cy - (ns * (cy - y)) / scale,
    });
  }, []);

  const zoomFromCenter = useCallback(
    (factor: number) => {
      const el = stageRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      zoomAt(viewRef.current.scale * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
    [zoomAt],
  );

  // Escape to close, lock body scroll, focus the close button. While the
  // editor is open, Escape dismisses it first rather than the whole viewer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (editingRef.current) setEditing(false);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // Native (non-passive) wheel listener so we can preventDefault the page
  // scroll. Images only — a PDF's page column scrolls natively instead.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || isPdf) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(viewRef.current.scale * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [isPdf, zoomAt]);

  function onPointerDown(e: React.PointerEvent) {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: distance(a, b), scale: viewRef.current.scale };
      drag.current = null;
    } else {
      drag.current = { px: e.clientX, py: e.clientY, x: viewRef.current.x, y: viewRef.current.y };
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      zoomAt(pinch.current.scale * (distance(a, b) / pinch.current.dist), mid.x, mid.y);
    } else if (drag.current && viewRef.current.scale > 1) {
      const d = drag.current;
      setView((v) => ({ ...v, x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) }));
    }
  }

  function endPointer(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) {
      drag.current = null;
    } else {
      const [p] = [...pointers.current.values()];
      drag.current = { px: p.x, py: p.y, x: viewRef.current.x, y: viewRef.current.y };
    }
  }

  function onDoubleClick(e: React.MouseEvent) {
    if (viewRef.current.scale > 1) reset();
    else zoomAt(2.5, e.clientX, e.clientY);
  }

  const ctrlBtn =
    "flex h-9 w-9 items-center justify-center rounded-full text-lg leading-none text-white transition-colors hover:bg-white/20 disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90"
      role="dialog"
      aria-modal="true"
      aria-label={`Receipt: ${receipt.originalName}`}
      data-testid="receipt-viewer"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-white">
        <span className="truncate text-sm font-medium" title={receipt.originalName}>
          {receipt.originalName}
        </span>
        <div className="flex items-center gap-1">
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className={ctrlBtn}
            aria-label="Open in a new tab"
            title="Open in a new tab"
            onClick={(e) => e.stopPropagation()}
          >
            ↗
          </a>
          <button
            ref={closeRef}
            className={ctrlBtn}
            onClick={onClose}
            aria-label="Close viewer"
            title="Close (Esc)"
            data-testid="receipt-viewer-close"
          >
            ✕
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className="relative flex-1 overflow-hidden"
        style={isPdf ? undefined : { touchAction: "none" }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {isPdf ? (
          // PDFs: per-page raster previews in a natively scrollable column;
          // the zoom buttons scale the column width (scroll does the panning).
          pdfPreview.failed ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-stone-400">
              <div className="text-5xl">📄</div>
              <div className="text-sm">Preview unavailable — use ↗ to open the PDF</div>
            </div>
          ) : !pdfPreview.manifest ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-stone-300">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-500 border-t-white" />
              <div className="text-sm">Rendering preview…</div>
            </div>
          ) : (
            <div className="h-full w-full overflow-auto">
              <div className="mx-auto" style={{ width: `${view.scale * 100}%` }}>
                {Array.from({ length: pdfPreview.manifest.pages }, (_, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={pdfPreviewPageUrl(receipt.id, i + 1)}
                    alt={`${receipt.originalName} page ${i + 1}`}
                    loading="lazy"
                    className="w-full"
                  />
                ))}
                {pdfPreview.manifest.omitted > 0 && (
                  <div className="bg-stone-100 px-4 py-3 text-center text-xs text-stone-500">
                    +{pdfPreview.manifest.omitted} more{" "}
                    {pdfPreview.manifest.omitted === 1 ? "page" : "pages"} not shown — use ↗ to
                    open the full PDF.
                  </div>
                )}
              </div>
            </div>
          )
        ) : (
          // Photos: custom zoom/pan; only real image receipts can be
          // rotated/cropped (canEdit).
          <div className="pointer-events-none flex h-full w-full items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={receipt.originalName}
              draggable={false}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endPointer}
              onPointerCancel={endPointer}
              onDoubleClick={onDoubleClick}
              style={{
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                cursor: view.scale > 1 ? "grab" : "zoom-in",
              }}
              className="pointer-events-auto max-h-full max-w-full touch-none select-none object-contain will-change-transform"
            />
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-5 flex flex-col items-center gap-2">
          {canEdit && (
            <button
              className="pointer-events-auto flex h-10 items-center justify-center gap-1.5 rounded-full bg-black/70 px-4 text-sm font-medium text-white shadow-lg backdrop-blur transition-colors hover:bg-black/80"
              onClick={() => setEditing(true)}
              aria-label="Rotate or crop this receipt"
              title="Rotate or crop"
              data-testid="receipt-viewer-edit"
            >
              ✂ Rotate / crop
            </button>
          )}
          <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-black/70 px-2 py-1 shadow-lg backdrop-blur">
            <button
              className={ctrlBtn}
              onClick={() => zoomFromCenter(1 / 1.4)}
              disabled={view.scale <= MIN_SCALE}
              aria-label="Zoom out"
              title="Zoom out"
            >
              −
            </button>
            <span className="w-12 select-none text-center text-xs font-medium tabular-nums text-white">
              {Math.round(view.scale * 100)}%
            </span>
            <button
              className={ctrlBtn}
              onClick={() => zoomFromCenter(1.4)}
              disabled={view.scale >= MAX_SCALE}
              aria-label="Zoom in"
              title="Zoom in"
            >
              +
            </button>
            <button
              className={ctrlBtn}
              onClick={reset}
              disabled={view.scale <= MIN_SCALE && view.x === 0 && view.y === 0}
              aria-label="Reset zoom"
              title="Reset zoom"
            >
              ⤢
            </button>
          </div>
        </div>
      </div>

      {editing && (
        <ReceiptImageEditor
          receiptId={receipt.id}
          src={src}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setVersion((v) => v + 1);
            setEditing(false);
            reset();
            onEdited?.();
          }}
        />
      )}
    </div>
  );
}
