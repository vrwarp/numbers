"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useDateLabel } from "@/lib/use-date-label";
import { formatCents } from "@/lib/money";

/** Thumbnail for a PDF receipt: the top slice of the server-rasterized preview
 *  (browsers can't thumbnail a PDF), falling back to a plain chip if it fails.
 *  Letter aspect keeps the tile's height stable while the raster loads. */
function PdfThumb({ id }: { id: string }) {
  const t = useTranslations("ReceiptGrid");
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="flex aspect-[17/22] w-full flex-col items-center justify-center text-stone-400">
        <div className="text-4xl">📄</div>
        <div className="text-xs font-semibold">{t("pdfChip")}</div>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/receipts/${id}/preview?page=1`}
      alt={t("pdfThumbAlt")}
      loading="lazy"
      onError={() => setFailed(true)}
      decoding="async"
      className="aspect-[17/22] w-full object-cover object-top"
      data-testid={`pdf-thumb-${id}`}
    />
  );
}

export interface ClaimRef {
  id: string;
  status: string;
  createdAt: string;
}

/** A receipt as returned by GET /api/receipts (claims = join data flattened).
 *  The annotation fields are optional because the upload POST's slimmer
 *  response is also cast to this shape; the grid refreshes from the GET. */
export interface ReceiptSummary {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  note: string;
  /** Merchant transcription from the receipt's annotation (background worker,
   *  claim-time fallback, or manual entry); "" until annotated. */
  merchant: string;
  createdAt: string;
  claims: ClaimRef[];
  /** Background AI read state: ready = a claim can use it without an AI call. */
  annotation?: "ready" | "pending" | "failed";
  extractedTotalCents?: number | null;
  extractedRefundCents?: number | null;
}

/**
 * One tile of the wall, memoized: with hundreds of receipts mounted, a filter
 * tap or a single-card selection must not re-render (or re-lay-out) every
 * sibling — the wall was measurably janky on mid-tier phones before this.
 * All props are primitives or parent-stable references, so the shallow
 * compare holds; translations/date formatting are hooks INSIDE the card.
 */
const ReceiptCard = memo(function ReceiptCard({
  receipt: r,
  selectable,
  isSelected,
  nudge,
  src,
  onToggle,
  onDelete,
  onSaveNote,
  onView,
}: {
  receipt: ReceiptSummary;
  selectable: boolean;
  isSelected: boolean;
  /** Pulse this card's ✓ circle — the claim bar's "select first" nudge. */
  nudge: boolean;
  src: string;
  onToggle?: (id: string) => void;
  onDelete?: (id: string) => void;
  onSaveNote?: (id: string, note: string) => void;
  onView?: (r: ReceiptSummary) => void;
}) {
  const t = useTranslations("ReceiptGrid");
  const tStatus = useTranslations("Common.status");
  const dateLabel = useDateLabel();
  // The ✓ circle opts out of hover-hiding when it must stay visible on
  // its own: a selected card (the fill IS the selection state) or a
  // card the "select first" nudge is pulsing.
  const pinnedCheck = isSelected || nudge;
  return (
    <div
      data-testid={`receipt-card-${r.id}`}
      data-open-id={r.id}
      // Selected cards get a ring in addition to the filled checkmark —
      // one small glyph alone is easy to read as decoration.
      className={`receipt-card card relative mb-3 overflow-hidden ${
        selectable ? "card-lift cursor-pointer select-none" : "opacity-70"
      } ${isSelected ? "ring-2 ring-indigo-500 ring-offset-1" : ""}`}
      onClick={selectable ? () => onToggle?.(r.id) : undefined}
    >
      {selectable && (
        // The real, focusable selection control (the card's onClick is a
        // pointer convenience on top). 44px hit target around a 32px
        // visual circle; Enter/Space toggle for keyboard users.
        <button
          type="button"
          className={`group absolute left-0.5 top-0.5 z-10 flex h-11 w-11 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${
            pinnedCheck ? "" : "receipt-card-action"
          }`}
          role="checkbox"
          aria-checked={isSelected}
          aria-label={t("selectReceipt", { name: r.originalName })}
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.(r.id);
          }}
          data-testid={`receipt-select-${r.id}`}
        >
          <span
            aria-hidden
            className={`flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-bold shadow ${
              isSelected
                ? "border-indigo-600 bg-indigo-600/80 text-white"
                : "border-stone-400 bg-white/90 text-stone-500 group-hover:border-indigo-500 group-hover:text-indigo-600"
            } ${nudge && !isSelected ? "nudge-ring-select border-indigo-600 text-indigo-600" : ""}`}
          >
            ✓
          </span>
        </button>
      )}
      {onDelete && (
        <button
          className="receipt-card-action absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white/80 text-xs text-stone-500 shadow hover:text-red-600"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(r.id);
          }}
          aria-label={t("deleteReceipt", { name: r.originalName })}
        >
          🗑
        </button>
      )}
      <div className="relative bg-stone-50">
        {r.mimeType === "application/pdf" ? (
          <PdfThumb id={r.id} />
        ) : (
          // Natural aspect ratio is what makes the wall a masonry; the
          // max-height clamp keeps a till-roll receipt from swallowing
          // its column (top-anchored crop — the merchant header is the
          // recognizable part), min-height covers the pre-load frame.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={src}
            src={src}
            alt={r.originalName}
            loading="lazy"
            decoding="async"
            className="max-h-96 min-h-20 w-full bg-stone-100 object-cover object-top"
          />
        )}
        {onView && (
          <button
            className="receipt-card-action absolute bottom-2 right-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white/80 text-stone-600 shadow hover:text-indigo-600"
            onClick={(e) => {
              e.stopPropagation();
              onView(r);
            }}
            aria-label={t("viewLarger", { name: r.originalName })}
            title={t("viewLargerTitle")}
            data-testid={`receipt-view-${r.id}`}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M15 3h6v6" />
              <path d="M9 21H3v-6" />
              <path d="M21 3l-7 7" />
              <path d="M3 21l7-7" />
            </svg>
          </button>
        )}
      </div>
      <div className="space-y-1 p-2">
        {onSaveNote ? (
          <input
            key={`note-${r.id}-${r.note}`}
            className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] text-stone-600 placeholder:italic hover:border-stone-200 focus:border-stone-300 focus:outline-none"
            defaultValue={r.note}
            placeholder={t("notePlaceholder")}
            maxLength={300}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== r.note) onSaveNote(r.id, v);
            }}
            aria-label={t("noteAria", { name: r.originalName })}
            data-testid={`receipt-note-${r.id}`}
          />
        ) : (
          r.note && <div className="truncate text-[11px] text-stone-600">{r.note}</div>
        )}
        {/* Background AI read state: what was read (merchant · net),
            or that the drip worker hasn't reached / gave up on it. */}
        {r.annotation && (
          <div
            className={`truncate text-[11px] ${
              r.annotation === "ready"
                ? "text-emerald-700"
                : r.annotation === "failed"
                  ? "text-amber-700"
                  : "text-stone-400 italic"
            }`}
            title={r.annotation === "ready" ? t("annotationReadyTitle") : undefined}
            data-testid={`receipt-annotation-${r.id}`}
            data-state={r.annotation}
          >
            {r.annotation === "ready"
              ? `✓ ${[
                  r.merchant,
                  formatCents(
                    (r.extractedTotalCents ?? 0) - (r.extractedRefundCents ?? 0)
                  ),
                ]
                  .filter(Boolean)
                  .join(" · ")}`
              : r.annotation === "failed"
                ? t("annotationFailed")
                : t("annotationPending")}
          </div>
        )}
        <div className="truncate text-[11px] text-stone-400">
          {t("caption", {
            date: dateLabel(r.createdAt),
            name: r.originalName,
          })}
          {r.status !== "unassigned" && t("processedSuffix")}
        </div>
        {r.claims.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {r.claims.map((c) => (
              <Link
                key={c.id}
                href={`/claims/${c.id}`}
                onClick={(e) => e.stopPropagation()}
                className="rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] text-indigo-700 hover:bg-indigo-100"
                data-testid={`claim-link-${r.id}-${c.id}`}
              >
                {c.status === "draft" ? tStatus("draft") : t("claimChip")}{" "}
                {dateLabel(c.createdAt)}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

/** Container-width → column count. Mirrors the container-query breakpoints the
 *  wall used while it was a CSS multi-column block (@md/@3xl/@5xl). */
function columnCountFor(width: number): number {
  if (width >= 1024) return 5;
  if (width >= 768) return 4;
  if (width >= 448) return 3;
  return 2;
}

/** Track the wall container's own width (not the viewport) so the same
 *  component packs sensibly full-page and inside the add-receipts dialog. */
function useColumnCount(ref: React.RefObject<HTMLDivElement | null>): number {
  const [count, setCount] = useState(2);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => setCount(columnCountFor(el.getBoundingClientRect().width));
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return count;
}

/**
 * The selectable receipt wall (Shoebox and the review screen's add-receipts
 * dialog): a masonry of photo-first tiles, each image at its natural aspect
 * ratio (clamped for till-roll receipts) so the wall reads like an
 * image-search results page. Tiles toggle selection when `selectable`; the
 * delete / note / view affordances appear only when their callbacks are
 * provided.
 *
 * Layout: independent column DIVS, round-robin filled — deliberately NOT CSS
 * `columns`. Multi-column balances the whole flow as one layout context, so
 * every lazily-loaded thumbnail that changes a card's height re-laid-out all
 * N cards; measured on a 4×-throttled phone against a 320-receipt wall that
 * was ~73% dropped frames while scrolling. Separate columns make each one its
 * own layout context, so a late image only reflows its own column.
 *
 * Perf contract: pass parent-STABLE callbacks (useCallback / state setters) —
 * each tile is memoized so a selection or filter change re-renders only the
 * cards whose props actually changed, not the whole wall.
 */
export default function ReceiptGrid({
  receipts,
  selectable = false,
  selected,
  onToggle,
  onDelete,
  onSaveNote,
  fileUrl,
  onView,
  nudgeSelect = false,
}: {
  receipts: ReceiptSummary[];
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  onDelete?: (id: string) => void;
  onSaveNote?: (id: string, note: string) => void;
  fileUrl?: (id: string) => string;
  onView?: (r: ReceiptSummary) => void;
  /** Pulse the first cards' ✓ circles — the claim bar's "select first" nudge. */
  nudgeSelect?: boolean;
}) {
  const wallRef = useRef<HTMLDivElement>(null);
  const columnCount = useColumnCount(wallRef);
  // Round-robin so the newest receipts read across the top row (and the two
  // nudged cards land side by side) rather than stacking down column one.
  const columns = useMemo(() => {
    const cols: ReceiptSummary[][] = Array.from({ length: columnCount }, () => []);
    receipts.forEach((r, i) => cols[i % columnCount].push(r));
    return cols;
  }, [receipts, columnCount]);

  return (
    <div className="@container">
      <div ref={wallRef} className="receipt-wall flex items-start gap-3">
        {columns.map((column, colIndex) => (
          <div key={colIndex} className="min-w-0 flex-1">
            {column.map((r, rowIndex) => (
              <ReceiptCard
                key={r.id}
                receipt={r}
                selectable={selectable}
                isSelected={selected?.has(r.id) ?? false}
                nudge={nudgeSelect && rowIndex === 0 && colIndex < 2}
                src={fileUrl ? fileUrl(r.id) : `/api/receipts/${r.id}/file`}
                onToggle={onToggle}
                onDelete={onDelete}
                onSaveNote={onSaveNote}
                onView={onView}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
