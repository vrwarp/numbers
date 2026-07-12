"use client";

/**
 * Hand-drawn signature capture (touch screen or mouse) — the literal
 * signature that gets stamped on the PDF's signature lines. Pointer events
 * cover finger, stylus, and mouse alike; the export is a transparent PNG
 * data URL trimmed to the inked area so it sits cleanly on the form line.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

// Drawing-surface resolution. The canvas overlays the writing area of the form's
// "Requested by" signature box (public/esign/signature-guide.png, cropped from
// the template). W/H matches that area's wide, short aspect so strokes map
// without distortion; the fractions below place it on the backdrop.
const W = 720;
const H = 94;
/** Drawable zone within the backdrop, measured from the template: it starts just
 *  under the "Requested by" bar and runs past the signature line into the gap
 *  above the "(Signature)" caption, so a signature can cross the line the way a
 *  real one does. */
const CELL_TOP = 28; // % from the top of the backdrop (bar bottom)
const CELL_HEIGHT = 44; // % (down to just above the "(Signature)" caption)
const CELL_INSET = 1.2; // % horizontal inset to clear the box's side borders

export default function SignaturePad({
  onChange,
  initial,
}: {
  onChange: (dataUrl: string | null) => void;
  initial?: string | null;
}) {
  const t = useTranslations("Esign");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    ctx.lineWidth = 3.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1e2a78"; // pen-ink blue, reads as a real signature on paper
    if (initial) {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        setHasInk(true);
      };
      img.src = initial;
    }
  }, [initial]);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    };
  }

  function exportInk() {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    // Trim to the inked bounding box (with padding) so stamping scales nicely.
    const data = ctx.getImageData(0, 0, W, H).data;
    let minX = W, minY = H, maxX = 0, maxY = 0, found = false;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * 4 + 3] > 10) {
          found = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (!found) {
      onChange(null);
      return;
    }
    const pad = 6;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(W, maxX + pad);
    maxY = Math.min(H, maxY + pad);
    const out = document.createElement("canvas");
    out.width = maxX - minX;
    out.height = maxY - minY;
    out.getContext("2d")!.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    onChange(out.toDataURL("image/png"));
  }

  return (
    <div className="space-y-2">
      {/* The backdrop is the form's actual "Requested by" signature box (cropped
          from the template) so the member sees exactly where and how large their
          signature lands. The drawing canvas overlays only the white cell above
          the signature line. */}
      <div className="relative w-full select-none overflow-hidden rounded-xl border-2 border-dashed border-stone-300 bg-white">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/esign/signature-guide.png"
          alt=""
          aria-hidden="true"
          draggable={false}
          className="pointer-events-none block w-full select-none"
        />
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          data-testid="signature-pad"
          className="absolute cursor-crosshair touch-none"
          style={{
            left: `${CELL_INSET}%`,
            width: `${100 - CELL_INSET * 2}%`,
            top: `${CELL_TOP}%`,
            height: `${CELL_HEIGHT}%`,
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drawing.current = true;
            const { x, y } = pos(e);
            const ctx = canvasRef.current!.getContext("2d")!;
            ctx.beginPath();
            ctx.moveTo(x, y);
            // A dot for taps, so single touches leave a mark too.
            ctx.lineTo(x + 0.1, y + 0.1);
            ctx.stroke();
            setHasInk(true);
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            const { x, y } = pos(e);
            const ctx = canvasRef.current!.getContext("2d")!;
            ctx.lineTo(x, y);
            ctx.stroke();
          }}
          onPointerUp={() => {
            drawing.current = false;
            exportInk();
          }}
          onPointerLeave={() => {
            if (drawing.current) {
              drawing.current = false;
              exportInk();
            }
          }}
        />
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-stone-400">{t("signAbove")}</p>
        <button
          type="button"
          className="text-xs text-indigo-600 underline disabled:opacity-40"
          disabled={!hasInk}
          data-testid="signature-clear"
          onClick={() => {
            const canvas = canvasRef.current!;
            canvas.getContext("2d")!.clearRect(0, 0, W, H);
            setHasInk(false);
            onChange(null);
          }}
        >
          {t("clearPad")}
        </button>
      </div>
    </div>
  );
}
