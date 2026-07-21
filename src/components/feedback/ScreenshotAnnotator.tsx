"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

/**
 * Screenshot annotation editor (docs/FEEDBACK_DESIGN.md §5). A canvas over the
 * captured image with the tools a reporter actually needs before sending:
 *   • Black out — a filled opaque box to REDACT private details (amounts,
 *     names). The important one: a screenshot can contain anything on screen.
 *   • Draw — a red pen to circle/point at the problem.
 *   • Highlight — a translucent marker to emphasise.
 * Plus Undo / Clear. Pointer Events unify mouse + touch (touch-action: none so
 * a finger draws instead of scrolling). Annotations are kept in NATURAL image
 * pixels, so the export is full-resolution regardless of the on-screen scale.
 */

type Point = { x: number; y: number };
type Anno =
  | { type: "blackout"; x: number; y: number; w: number; h: number }
  | { type: "stroke"; color: string; width: number; points: Point[] };

type Tool = "blackout" | "draw" | "highlight";

const PEN_COLOR = "#dc2626";
const HL_COLOR = "rgba(250, 204, 21, 0.4)";

export default function ScreenshotAnnotator({
  src,
  onDone,
  onCancel,
}: {
  src: string;
  onDone: (dataUrl: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("Feedback");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const annosRef = useRef<Anno[]>([]);
  const drawingRef = useRef<Anno | null>(null);
  const startRef = useRef<Point | null>(null);
  const [tool, setTool] = useState<Tool>("blackout");
  const toolRef = useRef<Tool>("blackout");
  toolRef.current = tool;
  const [count, setCount] = useState(0); // drives Undo/Clear enablement + redraw
  const [ready, setReady] = useState(false);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const all = drawingRef.current ? [...annosRef.current, drawingRef.current] : annosRef.current;
    for (const a of all) {
      if (a.type === "blackout") {
        ctx.fillStyle = "#000";
        ctx.fillRect(a.x, a.y, a.w, a.h);
      } else {
        ctx.strokeStyle = a.color;
        ctx.lineWidth = a.width;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.beginPath();
        a.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.stroke();
      }
    }
  }, []);

  // Load the image, size the backing canvas to its natural resolution.
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      setReady(true);
      redraw();
    };
    img.src = src;
  }, [src, redraw]);

  const toNatural = (e: PointerEvent | React.PointerEvent): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const strokeWidth = () => {
    const w = canvasRef.current?.width ?? 800;
    return toolRef.current === "highlight" ? Math.max(14, w / 36) : Math.max(3, w / 160);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!ready) return;
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    const p = toNatural(e);
    startRef.current = p;
    if (toolRef.current === "blackout") {
      drawingRef.current = { type: "blackout", x: p.x, y: p.y, w: 0, h: 0 };
    } else {
      drawingRef.current = {
        type: "stroke",
        color: toolRef.current === "highlight" ? HL_COLOR : PEN_COLOR,
        width: strokeWidth(),
        points: [p],
      };
    }
    redraw();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawingRef.current || !startRef.current) return;
    e.preventDefault();
    const p = toNatural(e);
    const cur = drawingRef.current;
    if (cur.type === "blackout") {
      const s = startRef.current;
      cur.x = Math.min(s.x, p.x);
      cur.y = Math.min(s.y, p.y);
      cur.w = Math.abs(p.x - s.x);
      cur.h = Math.abs(p.y - s.y);
    } else {
      cur.points.push(p);
    }
    redraw();
  };

  const commit = () => {
    const cur = drawingRef.current;
    drawingRef.current = null;
    startRef.current = null;
    if (!cur) return;
    // Discard a zero-size tap.
    if (cur.type === "blackout" && cur.w < 4 && cur.h < 4) {
      redraw();
      return;
    }
    if (cur.type === "stroke" && cur.points.length < 2) {
      redraw();
      return;
    }
    annosRef.current = [...annosRef.current, cur];
    setCount(annosRef.current.length);
  };

  useEffect(redraw, [count, redraw]);

  const undo = () => {
    annosRef.current = annosRef.current.slice(0, -1);
    setCount(annosRef.current.length);
  };
  const clear = () => {
    annosRef.current = [];
    setCount(0);
  };
  const done = () => {
    drawingRef.current = null;
    redraw();
    const url = canvasRef.current?.toDataURL("image/webp", 0.85);
    if (url) onDone(url);
  };

  const toolBtn = (key: Tool, label: string, icon: string) => (
    <button
      type="button"
      onClick={() => setTool(key)}
      aria-pressed={tool === key}
      data-testid={`annotate-tool-${key}`}
      className={`flex flex-1 flex-col items-center gap-0.5 rounded-lg px-2 py-2 text-[11px] font-semibold ${
        tool === key ? "bg-indigo-600 text-white" : "bg-white/10 text-white hover:bg-white/20"
      }`}
    >
      <span aria-hidden className="text-base">
        {icon}
      </span>
      {label}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-black/90 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      role="dialog"
      aria-modal="true"
      aria-label={t("annotate.title")}
      data-testid="screenshot-annotator"
    >
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <button type="button" className="text-sm font-medium text-white/80 hover:text-white" onClick={onCancel}>
          {t("annotate.cancel")}
        </button>
        <span className="text-sm font-semibold">{t("annotate.title")}</span>
        <button
          type="button"
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700"
          onClick={done}
          data-testid="annotate-done"
        >
          {t("annotate.done")}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center px-3">
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={commit}
          onPointerCancel={commit}
          className="max-h-full max-w-full touch-none rounded-lg bg-white shadow-2xl"
          style={{ objectFit: "contain" }}
          data-testid="annotate-canvas"
        />
      </div>

      <p className="px-4 pt-2 text-center text-[11px] text-white/50">{t("annotate.hint")}</p>

      <div className="flex items-center gap-2 p-3">
        {toolBtn("blackout", t("annotate.blackout"), "⬛")}
        {toolBtn("draw", t("annotate.draw"), "✏️")}
        {toolBtn("highlight", t("annotate.highlight"), "🖍️")}
        <button
          type="button"
          onClick={undo}
          disabled={count === 0}
          className="flex flex-1 flex-col items-center gap-0.5 rounded-lg bg-white/10 px-2 py-2 text-[11px] font-semibold text-white hover:bg-white/20 disabled:opacity-30"
          data-testid="annotate-undo"
        >
          <span aria-hidden className="text-base">
            ↶
          </span>
          {t("annotate.undo")}
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={count === 0}
          className="flex flex-1 flex-col items-center gap-0.5 rounded-lg bg-white/10 px-2 py-2 text-[11px] font-semibold text-white hover:bg-white/20 disabled:opacity-30"
          data-testid="annotate-clear"
        >
          <span aria-hidden className="text-base">
            ✕
          </span>
          {t("annotate.clear")}
        </button>
      </div>
    </div>
  );
}
