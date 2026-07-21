"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { fetchAndDeliver, isIosStandalonePwa } from "@/lib/pdf-delivery";
import { useBackDismiss } from "@/lib/use-back-dismiss";
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
  const t = useTranslations("Viewer");
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

  // Back gesture / hardware back dismiss the viewer (like Escape and ✕) instead
  // of navigating away from the receipts page. When the editor is open it owns
  // the topmost history entry, so back closes it first (LIFO) — see
  // `back-dismiss.ts` — then a second back closes the viewer.
  useBackDismiss(onClose);

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
      aria-label={t("ariaTitle", { name: receipt.originalName })}
      data-testid="receipt-viewer"
    >
      {/* Safe-area padded: this surface is fixed inset-0 under viewport-fit
          cover, so without the insets the close button sits under the iOS
          status bar/notch and the controls under the home indicator. */}
      <div className="flex items-center justify-between gap-3 py-3 pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] pt-[calc(0.75rem+env(safe-area-inset-top))] text-white">
        <span className="truncate text-sm font-medium" title={receipt.originalName}>
          {receipt.originalName}
        </span>
        <div className="flex items-center gap-1">
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className={ctrlBtn}
            aria-label={t("openNewTab")}
            title={t("openNewTab")}
            onClick={(e) => {
              e.stopPropagation();
              // iOS standalone PWA: the new tab is an overlay browser without
              // the session cookie (it would show the sign-in page) — fetch
              // the bytes in-app and hand them to the share sheet instead.
              if (isIosStandalonePwa()) {
                e.preventDefault();
                void fetchAndDeliver(src, receipt.originalName).catch(() => {});
              }
            }}
          >
            ↗
          </a>
          <button
            ref={closeRef}
            className={ctrlBtn}
            onClick={onClose}
            aria-label={t("close")}
            title={t("closeTitle")}
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
              <div className="text-sm">{t("previewUnavailable")}</div>
            </div>
          ) : !pdfPreview.manifest ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-stone-300">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-500 border-t-white" />
              <div className="text-sm">{t("rendering")}</div>
            </div>
          ) : (
            <div className="h-full w-full overflow-auto overscroll-contain">
              <div className="mx-auto" style={{ width: `${view.scale * 100}%` }}>
                {Array.from({ length: pdfPreview.manifest.pages }, (_, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={pdfPreviewPageUrl(receipt.id, i + 1)}
                    alt={t("pageAlt", { name: receipt.originalName, page: i + 1 })}
                    loading="lazy"
                    className="w-full"
                  />
                ))}
                {pdfPreview.manifest.omitted > 0 && (
                  <div className="bg-stone-100 px-4 py-3 text-center text-xs text-stone-500">
                    {t("omitted", { omitted: pdfPreview.manifest.omitted })}
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
                // iOS long-press save/copy callout fights the pan gesture.
                WebkitTouchCallout: "none",
              }}
              className="pointer-events-auto max-h-full max-w-full touch-none select-none object-contain will-change-transform"
            />
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-[calc(1.25rem+env(safe-area-inset-bottom))] flex flex-col items-center gap-2">
          {canEdit && (
            <button
              className="pointer-events-auto flex h-10 items-center justify-center gap-1.5 rounded-full bg-black/70 px-4 text-sm font-medium text-white shadow-lg backdrop-blur transition-colors hover:bg-black/80"
              onClick={() => setEditing(true)}
              aria-label={t("editAria")}
              title={t("editTitle")}
              data-testid="receipt-viewer-edit"
            >
              {t("editButton")}
            </button>
          )}
          <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-black/70 px-2 py-1 shadow-lg backdrop-blur">
            <button
              className={ctrlBtn}
              onClick={() => zoomFromCenter(1 / 1.4)}
              disabled={view.scale <= MIN_SCALE}
              aria-label={t("zoomOut")}
              title={t("zoomOut")}
            >
              −
            </button>
            <span className="w-12 select-none text-center text-xs font-medium tabular-nums text-white">
              {t("zoomLevel", { percent: Math.round(view.scale * 100) })}
            </span>
            <button
              className={ctrlBtn}
              onClick={() => zoomFromCenter(1.4)}
              disabled={view.scale >= MAX_SCALE}
              aria-label={t("zoomIn")}
              title={t("zoomIn")}
            >
              +
            </button>
            <button
              className={ctrlBtn}
              onClick={reset}
              disabled={view.scale <= MIN_SCALE && view.x === 0 && view.y === 0}
              aria-label={t("resetZoom")}
              title={t("resetZoom")}
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
