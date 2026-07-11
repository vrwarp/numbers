"use client";

/**
 * Click-to-stamp signing surface (docs/ESIGN_DESIGN.md click-to-stamp): shows
 * the actual document and lets the signer place their signature on it by
 * tapping/dragging — DocuSign-style. The signature seeds on the correct line
 * (zero taps for the common case) and can be moved anywhere. Emits a
 * page-normalized placement (bottom-left origin) that both the browser
 * overlay and the server's pdf-lib stamp agree on exactly.
 *
 * The page image is rendered from the EXACT bytes passed in (client-side
 * pdf.js), never a server raster — so what you place your signature on is
 * provably the document being signed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderFirstPage, type RenderedPage } from "@/lib/esign/pdfjs-client";
import { clampPlacement, roundPlacement, type SignaturePlacement } from "@/lib/esign/placement";

export default function DocumentSignField({
  bytes,
  signatureImage,
  anchor,
  onChange,
}: {
  bytes: ArrayBuffer;
  signatureImage: string;
  anchor: SignaturePlacement;
  onChange: (placement: SignaturePlacement) => void;
}) {
  const [page, setPage] = useState<RenderedPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placement, setPlacement] = useState<SignaturePlacement>(anchor);
  const [imgAspect, setImgAspect] = useState(0.35); // naturalH / naturalW
  const [nudged, setNudged] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

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
      const clamped = clampPlacement(p, heightRatioPerWidth);
      setPlacement(clamped);
      onChange(roundPlacement(clamped));
    },
    [heightRatioPerWidth, onChange]
  );

  // Seed the parent with the anchor on first render.
  useEffect(() => {
    commit(anchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function place(clientX: number, clientY: number) {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const cw = box.width;
    const ch = box.height;
    const stampWpx = placement.widthRatio * cw;
    // Drop point = bottom-center of the stamp.
    const xRatio = (clientX - box.left - stampWpx / 2) / cw;
    const yRatio = (ch - (clientY - box.top)) / ch;
    commit({ ...placement, xRatio, yRatio });
    setNudged(true);
  }

  const dragging = useRef(false);

  if (error) {
    return (
      <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
        Couldn&apos;t show the document to sign on. {error}
      </div>
    );
  }
  if (!page) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-stone-200 text-sm text-stone-400">
        Opening the document…
      </div>
    );
  }

  // Overlay geometry (CSS %, so it scales with the responsive image).
  const leftPct = placement.xRatio * 100;
  const widthPct = placement.widthRatio * 100;
  const stampHeightFracOfHeight = placement.widthRatio * heightRatioPerWidth;
  const topPct = (1 - placement.yRatio - stampHeightFracOfHeight) * 100;

  return (
    <div className="space-y-2">
      <p className="text-sm text-stone-600">
        Your signature is on the line. Tap anywhere on the form to move it.
      </p>
      <div
        ref={boxRef}
        className="relative w-full touch-none select-none overflow-hidden rounded-lg border border-stone-300 bg-white"
        style={{ aspectRatio: `${page.widthPx} / ${page.heightPx}` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          place(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (dragging.current) place(e.clientX, e.clientY);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        data-testid="document-sign-field"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={page.dataUrl} alt="Document to sign" className="pointer-events-none block w-full" />
        <div
          className={`pointer-events-none absolute rounded ${nudged ? "" : "ring-2 ring-indigo-400/70 ring-offset-1"}`}
          style={{ left: `${leftPct}%`, top: `${topPct}%`, width: `${widthPct}%` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={signatureImage} alt="Your signature" className="block w-full" />
        </div>
      </div>
      <div className="flex items-center justify-between text-xs text-stone-400">
        <span>Drag to fine-tune the position.</span>
        <button
          type="button"
          className="text-indigo-600 underline"
          onClick={() => {
            setNudged(false);
            commit(anchor);
          }}
          data-testid="reset-placement"
        >
          Back to the signature line
        </button>
      </div>
    </div>
  );
}
