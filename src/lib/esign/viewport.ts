/**
 * Zoom/pan math for the signing preview (DocumentSignField). Pure and
 * dependency-free — the same way placement.ts is — so the pinch/zoom/pan
 * behaviour is unit-testable without a DOM. A `View` is the CSS transform
 * applied to the preview content: `translate(tx,ty) scale(scale)` about the
 * top-left origin, in viewport (box-relative) pixels. None of this touches the
 * emitted signature placement — zoom is purely how the page is displayed.
 */

export interface View {
  scale: number;
  /** Translation in box-relative px (top-left origin). */
  tx: number;
  ty: number;
}

/** The signing surface's on-screen size, in px. */
export interface Box {
  width: number;
  height: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
/** Multiplier for one press of the zoom-in button (its inverse zooms out). */
export const ZOOM_STEP = 1.5;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  return clamp(scale, min, max);
}

/**
 * Clamp a view to legal bounds: scale into [min,max], and — so the content can
 * never be dragged off the viewport — translation into
 * [box·(1−scale), 0] on each axis. At scale 1 the content exactly fills the
 * box, so it snaps back to the origin.
 */
export function clampView(v: View, box: Box, min = MIN_SCALE, max = MAX_SCALE): View {
  const scale = clampScale(v.scale, min, max);
  if (scale <= 1) return { scale, tx: 0, ty: 0 };
  const minTx = box.width * (1 - scale);
  const minTy = box.height * (1 - scale);
  return { scale, tx: clamp(v.tx, minTx, 0), ty: clamp(v.ty, minTy, 0) };
}

/** The content-space point currently displayed under a box-relative point. */
export function contentPointUnder(v: View, boxX: number, boxY: number): { cx: number; cy: number } {
  return { cx: (boxX - v.tx) / v.scale, cy: (boxY - v.ty) / v.scale };
}

/**
 * Zoom to `nextScale` while keeping the content point under (boxX,boxY)
 * anchored there — the focal-point-preserving zoom used by both the buttons
 * (focal point = box center) and the wheel/keyboard, if added.
 */
export function zoomAbout(v: View, box: Box, boxX: number, boxY: number, nextScale: number): View {
  const scale = clampScale(nextScale);
  const { cx, cy } = contentPointUnder(v, boxX, boxY);
  return clampView({ scale, tx: boxX - cx * scale, ty: boxY - cy * scale }, box);
}

/** Zoom about the viewport centre (what the +/− buttons do). */
export function zoomByCenter(v: View, box: Box, factor: number): View {
  return zoomAbout(v, box, box.width / 2, box.height / 2, v.scale * factor);
}

/** Anchor captured when a pinch begins: the content point under the midpoint. */
export interface PinchStart {
  dist: number;
  scale: number;
  cx: number;
  cy: number;
}

export function beginPinch(v: View, box: Box, midX: number, midY: number, dist: number): PinchStart {
  const { cx, cy } = contentPointUnder(v, midX, midY);
  return { dist, scale: v.scale, cx, cy };
}

/**
 * Live pinch update: scale follows the finger-distance ratio and the anchored
 * content point stays under the (possibly moving) midpoint.
 */
export function pinchView(start: PinchStart, box: Box, midX: number, midY: number, dist: number): View {
  const scale = clampScale((start.scale * dist) / (start.dist || 1));
  return clampView({ scale, tx: midX - start.cx * scale, ty: midY - start.cy * scale }, box);
}

/** Anchor captured when a pan begins. */
export interface PanStart {
  x: number;
  y: number;
  tx: number;
  ty: number;
}

export function panView(v: View, box: Box, start: PanStart, x: number, y: number): View {
  return clampView({ scale: v.scale, tx: start.tx + (x - start.x), ty: start.ty + (y - start.y) }, box);
}

/** Whether the view is at rest (100%, no offset) — e.g. to disable "reset". */
export function isIdentity(v: View): boolean {
  return v.scale === 1 && v.tx === 0 && v.ty === 0;
}
