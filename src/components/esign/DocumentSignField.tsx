"use client";

/**
 * Click-to-stamp signing surface (docs/ESIGN_DESIGN.md click-to-stamp): shows
 * the actual document with a "Tap to sign" placeholder ON the signature line.
 * Nothing is stamped until the signer taps it — the tap is the required
 * affirmative act (good UETA evidence, and the familiar sign-here pattern).
 * After tapping, the signature sits on the line and can be dragged anywhere;
 * removing it returns to the placeholder state and disables signing again.
 *
 * The page image is rendered from the EXACT bytes passed in (client-side
 * pdf.js), never a server raster — so what you place your signature on is
 * provably the document being signed. Emits a page-normalized placement
 * (bottom-left origin) that the browser overlay and the server's pdf-lib
 * stamp agree on exactly, or null while unplaced.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { renderFirstPage, type RenderedPage } from "@/lib/esign/pdfjs-client";
import { clampPlacement, fitWidthToHeight, roundPlacement, type SignaturePlacement } from "@/lib/esign/placement";

/**
 * Cap the stamped signature to roughly the height of the form's printed-name
 * line (~18pt on the 612×792 CFCC template, matching the "Name (Please print)"
 * field). Without this, a compact mark scaled to the full signature column
 * blows up vertically — a near-square doodle became a ~2-inch-tall blob and
 * even a real signature overran the line.
 */
const SIG_MAX_HEIGHT_PT = 18;

export default function DocumentSignField({
  bytes,
  signatureImage,
  anchor,
  onChange,
}: {
  bytes: ArrayBuffer;
  signatureImage: string;
  anchor: SignaturePlacement;
  onChange: (placement: SignaturePlacement | null) => void;
}) {
  const t = useTranslations("Esign");
  const [page, setPage] = useState<RenderedPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState(false);
  const [placement, setPlacement] = useState<SignaturePlacement>(anchor);
  const [imgAspect, setImgAspect] = useState(0.35); // naturalH / naturalW
  const boxRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

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

  /** The required affirmative act: tapping the sign-here tab stamps the
   *  signature on the line. Until then the parent holds no placement and
   *  the sign button stays disabled. */
  function placeAtAnchor() {
    setPlaced(true);
    commit(anchor);
  }

  function unplace() {
    setPlaced(false);
    dragging.current = false;
    setPlacement(anchor);
    onChange(null);
  }

  function moveTo(clientX: number, clientY: number) {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const stampWpx = placement.widthRatio * box.width;
    // Drop point = bottom-center of the stamp.
    const xRatio = (clientX - box.left - stampWpx / 2) / box.width;
    const yRatio = (box.height - (clientY - box.top)) / box.height;
    commit({ ...placement, xRatio, yRatio });
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

  return (
    <div className="space-y-2">
      <p className="text-sm text-stone-600">
        {placed ? t("signedDragHint") : t("tapTabHint")}
      </p>
      <div
        ref={boxRef}
        className="relative w-full touch-none select-none overflow-hidden rounded-lg border border-stone-300 bg-white"
        style={{ aspectRatio: `${page.widthPx} / ${page.heightPx}` }}
        onPointerDown={(e) => {
          if (!placed) return; // signing requires tapping the tab first
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          moveTo(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (dragging.current) moveTo(e.clientX, e.clientY);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        data-testid="document-sign-field"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={page.dataUrl} alt={t("docAlt")} className="pointer-events-none block w-full" />
        {placed ? (
          <div
            className="pointer-events-none absolute"
            style={{ left: `${leftPct}%`, top: `${topPct}%`, width: `${widthPct}%` }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={signatureImage} alt={t("signatureAlt")} className="block w-full" />
          </div>
        ) : (
          <button
            type="button"
            onClick={placeAtAnchor}
            className="absolute flex animate-pulse items-center justify-center gap-1 rounded-md border-2 border-amber-500 bg-amber-300/90 py-1.5 text-xs font-bold text-amber-950 shadow-md motion-reduce:animate-none"
            style={{
              left: `${anchor.xRatio * 100}%`,
              bottom: `${anchor.yRatio * 100}%`,
              width: `${anchor.widthRatio * 100}%`,
            }}
            data-testid="tap-to-sign"
          >
            {t("tapToSign")}
          </button>
        )}
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
