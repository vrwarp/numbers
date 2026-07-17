"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useDateLabel } from "@/lib/use-date-label";

/** Thumbnail for a PDF receipt: the top slice of the server-rasterized preview
 *  (browsers can't thumbnail a PDF), falling back to a plain chip if it fails. */
function PdfThumb({ id }: { id: string }) {
  const t = useTranslations("ReceiptGrid");
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="text-center text-stone-400">
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
      className="h-full w-full object-cover object-top"
      data-testid={`pdf-thumb-${id}`}
    />
  );
}

export interface ClaimRef {
  id: string;
  status: string;
  createdAt: string;
}

/** A receipt as returned by GET /api/receipts (claims = join data flattened). */
export interface ReceiptSummary {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  note: string;
  createdAt: string;
  claims: ClaimRef[];
}

/**
 * The selectable receipt-card grid (Shoebox and the review screen's
 * add-receipts dialog). Cards toggle selection when `selectable`; the delete /
 * note / view affordances appear only when their callbacks are provided.
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
}: {
  receipts: ReceiptSummary[];
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  onDelete?: (id: string) => void;
  onSaveNote?: (id: string, note: string) => void;
  fileUrl?: (id: string) => string;
  onView?: (r: ReceiptSummary) => void;
}) {
  const t = useTranslations("ReceiptGrid");
  const tStatus = useTranslations("Common.status");
  const dateLabel = useDateLabel();
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {receipts.map((r) => {
        const isSelected = selected?.has(r.id) ?? false;
        return (
          <div
            key={r.id}
            data-testid={`receipt-card-${r.id}`}
      data-open-id={r.id}
            // Selection is shown by the filled checkmark alone — no outline.
            className={`card relative overflow-hidden ${
              selectable ? "card-lift cursor-pointer select-none" : "opacity-70"
            }`}
            onClick={selectable ? () => onToggle?.(r.id) : undefined}
          >
            {selectable && (
              <div
                className={`absolute left-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-bold shadow ${
                  isSelected
                    ? "border-indigo-600 bg-indigo-600/80 text-white"
                    : "border-stone-300 bg-white/80 text-stone-500"
                }`}
                aria-checked={isSelected}
                role="checkbox"
              >
                ✓
              </div>
            )}
            {onDelete && (
              <button
                className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white/80 text-xs text-stone-500 shadow hover:text-red-600"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(r.id);
                }}
                aria-label={t("deleteReceipt", { name: r.originalName })}
              >
                🗑
              </button>
            )}
            <div className="relative flex h-36 items-center justify-center bg-stone-50">
              {r.mimeType === "application/pdf" ? (
                <PdfThumb id={r.id} />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={fileUrl?.(r.id)}
                  src={fileUrl ? fileUrl(r.id) : `/api/receipts/${r.id}/file`}
                  alt={r.originalName}
                  className="h-full w-full object-cover"
                />
              )}
              {onView && (
                <button
                  className="absolute bottom-2 right-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white/80 text-stone-600 shadow hover:text-indigo-600"
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
              <div className="truncate text-xs font-medium">{r.originalName}</div>
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
              <div className="text-[11px] text-stone-400">
                {t("meta", {
                  date: dateLabel(r.createdAt),
                  kb: (r.sizeBytes / 1024).toFixed(0),
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
      })}
    </div>
  );
}
