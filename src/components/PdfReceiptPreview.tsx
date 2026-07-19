"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import PdfLink from "@/components/PdfLink";

export interface PdfPreviewManifest {
  pages: number;
  omitted: number;
}

/** Fetch a PDF receipt's preview manifest. The server renders and caches all
 *  page images during this request, so "loading" covers the actual render.
 *  Pass an empty id to skip (e.g. when the receipt is not a PDF). */
export function usePdfPreviewManifest(receiptId: string) {
  const [manifest, setManifest] = useState<PdfPreviewManifest | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!receiptId) return;
    let cancelled = false;
    setManifest(null);
    setFailed(false);
    fetch(`/api/receipts/${receiptId}/preview`)
      .then(async (res) => {
        if (!res.ok) throw new Error("preview failed");
        const m = (await res.json()) as PdfPreviewManifest;
        if (!cancelled) setManifest(m);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [receiptId]);
  return { manifest, failed };
}

export function pdfPreviewPageUrl(receiptId: string, page: number): string {
  return `/api/receipts/${receiptId}/preview?page=${page}`;
}

/**
 * Inline preview of a PDF receipt: one <img> per rendered page (mobile
 * browsers won't display an embedded PDF), a "+N more pages" note when the
 * document was truncated, and always a link to the original PDF. While the
 * server rasterizes (first view of a receipt) a spinner says so; if the
 * render fails, falls back to a plain PDF chip so the row is never a blank
 * box. The receipt stays a PDF everywhere else — this is a view only, which
 * is why it lives apart from the image/crop path.
 */
export default function PdfReceiptPreview({
  receiptId,
  fileHref,
}: {
  receiptId: string;
  /** Link target for the original PDF (defaults to the file route). */
  fileHref?: string;
}) {
  const t = useTranslations("PdfPreview");
  const { manifest, failed } = usePdfPreviewManifest(receiptId);
  const openHref = fileHref ?? `/api/receipts/${receiptId}/file`;

  return (
    <div className="flex flex-col">
      {failed ? (
        <div className="flex flex-col items-center gap-1 py-10 text-stone-400">
          <div className="text-4xl">📄</div>
          <div className="text-xs font-semibold">{t("chip")}</div>
        </div>
      ) : !manifest ? (
        <div
          className="flex flex-col items-center gap-3 py-10 text-stone-400"
          data-testid={`pdf-preview-loading-${receiptId}`}
        >
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-stone-300 border-t-indigo-500" />
          <div className="text-xs font-medium">{t("rendering")}</div>
        </div>
      ) : (
        <>
          {Array.from({ length: manifest.pages }, (_, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={pdfPreviewPageUrl(receiptId, i + 1)}
              alt={t("pageAlt", { page: i + 1 })}
              loading="lazy"
              className="w-full"
              data-testid={i === 0 ? `pdf-preview-${receiptId}` : undefined}
            />
          ))}
          {manifest.omitted > 0 && (
            <div className="border-t border-stone-200 bg-stone-50 px-4 py-3 text-center text-xs text-stone-500">
              {t("omitted", { omitted: manifest.omitted })}
            </div>
          )}
        </>
      )}
      <PdfLink
        href={openHref}
        filename="receipt.pdf"
        className="border-t border-stone-100 px-4 py-2 text-center text-sm text-indigo-600 underline"
      >
        {t("open")}
      </PdfLink>
    </div>
  );
}
