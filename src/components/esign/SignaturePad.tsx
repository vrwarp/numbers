"use client";

/**
 * Hand-drawn signature capture (touch screen or mouse) — the literal
 * signature that gets stamped on the PDF's signature lines. Pointer events
 * cover finger, stylus, and mouse alike; the export is a transparent PNG
 * data URL trimmed to the inked area so it sits cleanly on the form line.
 *
 * Strokes are kept as data (not just pixels) so one stray mark can be
 * UNDONE — on a phone a signature takes several strokes, and "Clear and
 * start over" as the only correction forced a full redraw.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

// Drawing-surface resolution. The canvas overlays the writing area of the form's
// "Requested by" signature box (public/esign/signature-guide.png, cropped from
// the template — the box is cropped narrow on the right so it renders taller,
// giving more room to sign). W/H matches the writing area's aspect so strokes
// map without distortion; the fractions below place it on the backdrop.
const W = 720;
const H = 163;
// Supersample the buffer so ink stays crisp on high-DPI phone screens (the
// visual element is often wider than 720 CSS px on a Retina display).
const SCALE = 2;
/** Drawable zone within the backdrop, measured from the template: it starts just
 *  under the "Requested by" bar and runs past the signature line down over the
 *  "(Signature)" caption, so a signature can cross the line — and overlap the
 *  caption — the way a real one does; the preview shows the overlap so the
 *  signer can judge it. */
const CELL_TOP = 28; // % from the top of the backdrop (bar bottom)
const CELL_HEIGHT = 60; // % (down over the "(Signature)" caption)
const CELL_INSET = 1.2; // % horizontal inset to clear the box's side borders

type Stroke = { x: number; y: number }[];

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
  const strokes = useRef<Stroke[]>([]);
  // A previously saved signature loads as a base layer beneath new strokes;
  // Undo only removes strokes, never the restored base.
  const baseImage = useRef<HTMLImageElement | null>(null);
  const [hasInk, setHasInk] = useState(false);
  const [strokeCount, setStrokeCount] = useState(0);

  function ctx2d() {
    return canvasRef.current!.getContext("2d")!;
  }

  function applyPen(ctx: CanvasRenderingContext2D) {
    ctx.lineWidth = 3.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1e2a78"; // pen-ink blue, reads as a real signature on paper
  }

  useEffect(() => {
    const ctx = ctx2d();
    // All drawing happens in logical W×H coordinates on the supersampled buffer.
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    applyPen(ctx);
    if (initial) {
      const img = new Image();
      img.onload = () => {
        baseImage.current = img;
        ctx.drawImage(img, 0, 0, W, H);
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

  /** Clear and replay the base layer + every remaining stroke. */
  function redraw() {
    const ctx = ctx2d();
    ctx.clearRect(0, 0, W, H);
    if (baseImage.current) ctx.drawImage(baseImage.current, 0, 0, W, H);
    for (const stroke of strokes.current) {
      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      if (stroke.length === 1) ctx.lineTo(stroke[0].x + 0.1, stroke[0].y + 0.1);
      for (const p of stroke.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  }

  function exportInk() {
    const canvas = canvasRef.current!;
    const ctx = ctx2d();
    const BW = W * SCALE;
    const BH = H * SCALE;
    // Trim to the inked bounding box (with padding) so stamping scales nicely.
    const data = ctx.getImageData(0, 0, BW, BH).data;
    let minX = BW, minY = BH, maxX = 0, maxY = 0, found = false;
    for (let y = 0; y < BH; y++) {
      for (let x = 0; x < BW; x++) {
        if (data[(y * BW + x) * 4 + 3] > 10) {
          found = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (!found) {
      setHasInk(false);
      onChange(null);
      return;
    }
    const pad = 6 * SCALE;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(BW, maxX + pad);
    maxY = Math.min(BH, maxY + pad);
    const out = document.createElement("canvas");
    out.width = maxX - minX;
    out.height = maxY - minY;
    out.getContext("2d")!.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    setHasInk(true);
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
          width={W * SCALE}
          height={H * SCALE}
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
            strokes.current.push([{ x, y }]);
            setStrokeCount(strokes.current.length);
            const ctx = ctx2d();
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
            strokes.current[strokes.current.length - 1]?.push({ x, y });
            const ctx = ctx2d();
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
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-stone-400">{t("signAbove")}</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="text-xs text-indigo-600 underline disabled:opacity-40"
            disabled={strokeCount === 0}
            data-testid="signature-undo"
            onClick={() => {
              strokes.current.pop();
              setStrokeCount(strokes.current.length);
              redraw();
              exportInk();
            }}
          >
            {t("undoStroke")}
          </button>
          <button
            type="button"
            className="text-xs text-indigo-600 underline disabled:opacity-40"
            disabled={!hasInk}
            data-testid="signature-clear"
            onClick={() => {
              strokes.current = [];
              setStrokeCount(0);
              baseImage.current = null;
              ctx2d().clearRect(0, 0, W, H);
              setHasInk(false);
              onChange(null);
            }}
          >
            {t("clearPad")}
          </button>
        </div>
      </div>
    </div>
  );
}
