"use client";

/**
 * Hand-drawn signature capture (touch screen or mouse) — the literal
 * signature that gets stamped on the PDF's signature lines. Pointer events
 * cover finger, stylus, and mouse alike; the export is a transparent PNG
 * data URL trimmed to the inked area so it sits cleanly on the form line.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

const W = 560;
const H = 200;

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
    ctx.lineWidth = 2.4;
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
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        data-testid="signature-pad"
        className="w-full cursor-crosshair touch-none rounded-xl border-2 border-dashed border-stone-300 bg-white"
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
