"use client";

import { useState } from "react";

/**
 * Inline preview of a PDF receipt. Renders the server-rasterized image (mobile
 * browsers won't display an embedded PDF) and always offers a link to the
 * original PDF. If the raster fails, falls back to a plain PDF chip so the row
 * is never a blank box. The receipt stays a PDF everywhere else — this is a
 * view only, which is why it lives apart from the image/crop path.
 */
export default function PdfReceiptPreview({
  receiptId,
  fileHref,
}: {
  receiptId: string;
  /** Link target for the original PDF (defaults to the file route). */
  fileHref?: string;
}) {
  const [failed, setFailed] = useState(false);
  const openHref = fileHref ?? `/api/receipts/${receiptId}/file`;

  return (
    <div className="flex flex-col">
      {failed ? (
        <div className="flex flex-col items-center gap-1 py-10 text-stone-400">
          <div className="text-4xl">📄</div>
          <div className="text-xs font-semibold">PDF receipt</div>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/receipts/${receiptId}/preview`}
          alt="PDF receipt preview"
          loading="lazy"
          onError={() => setFailed(true)}
          className="w-full"
          data-testid={`pdf-preview-${receiptId}`}
        />
      )}
      <a
        href={openHref}
        target="_blank"
        rel="noopener noreferrer"
        className="border-t border-stone-100 px-4 py-2 text-center text-sm text-indigo-600 underline"
      >
        Open PDF receipt ↗
      </a>
    </div>
  );
}
