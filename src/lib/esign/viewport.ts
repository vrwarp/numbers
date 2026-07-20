/**
 * Zoom/pan math for the signing preview (DocumentSignField) and the inline
 * receipt viewer (PanZoomImage). Pure and dependency-free — the same way
 * placement.ts is — so the pinch/zoom/pan behaviour is unit-testable without a
 * DOM. A `View` is the CSS transform applied to the content:
 * `translate(tx,ty) scale(scale)` about the top-left origin, in viewport
 * (box-relative) pixels. None of this touches the emitted signature placement —
 * zoom is purely how the page is displayed.
 *
 * Two shapes of surface share this math:
 * - the signing preview, where the content at scale 1 exactly fills the box
 *   and zoom only goes in — the original `clampView`/`zoomAbout`/… helpers,
 *   kept with their exact behaviour as wrappers over a box-sized `Frame`;
 * - the receipt viewer, where the content's layout size differs from the
 *   visible box and the scale may drop below 1 to fit the whole image —
 *   the `Frame`-based helpers (`clampViewIn` and friends), which center the
 *   content on any axis it doesn't fill.
 */

export interface View {
  scale: number;
  /** Translation in box-relative px (top-left origin). */
  tx: number;
  ty: number;
}

/** An on-screen size, in px — the visible viewport or the content's layout. */
export interface Box {
  width: number;
  height: number;
}

/**
 * A pannable surface: the visible box, the content's untransformed layout size
 * (what scale 1 means), and the legal scale range.
 */
export interface Frame {
  box: Box;
  content: Box;
  minScale: number;
  maxScale: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
/** Multiplier for one press of the zoom-in button (its inverse zooms out). */
export const ZOOM_STEP = 1.5;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The signing surface's frame: content fills the box, zoom-in only. */
const boxFrame = (box: Box, min = MIN_SCALE, max = MAX_SCALE): Frame => ({
  box,
  content: box,
  minScale: min,
  maxScale: max,
});

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  return clamp(scale, min, max);
}

/**
 * Scales at which the content's width / height exactly fit the box. Sub-pixel
 * layout jitter (fractional rects snapped to device pixels) can leave a fit a
 * hair off 1; snap those so "exactly fits" is representable and stable — the
 * fitted transform is then a clean identity, not matrix(0.9998…).
 */
export function fitScales(box: Box, content: Box): { fitWidth: number; fitHeight: number } {
  const fit = (boxDim: number, contentDim: number) => {
    const s = contentDim > 0 ? boxDim / contentDim : 1;
    return Math.abs(s - 1) < 0.005 ? 1 : s;
  };
  return { fitWidth: fit(box.width, content.width), fitHeight: fit(box.height, content.height) };
}

/** The largest scale that shows the whole content inside the box. */
export function containScale(box: Box, content: Box): number {
  const { fitWidth, fitHeight } = fitScales(box, content);
  return Math.min(fitWidth, fitHeight);
}

/** One axis of clampViewIn: content smaller than the box rides centered
 *  (translation is forced, not free); larger content keeps its edges at or
 *  outside the box edges so no background shows through. Content within half
 *  a pixel of the box counts as an exact fit and pins to 0, so the fitted
 *  transform stays a clean identity across sub-pixel layout jitter. */
function clampAxis(t: number, boxDim: number, contentDim: number): number {
  if (contentDim < boxDim - 0.5) return (boxDim - contentDim) / 2;
  if (contentDim <= boxDim + 0.5) return 0;
  return clamp(t, boxDim - contentDim, 0);
}

/** Clamp a view to a frame's legal bounds: scale into [min,max], translation
 *  per-axis (centered when the content fits, edge-bounded when it doesn't). */
export function clampViewIn(f: Frame, v: View): View {
  const scale = clamp(v.scale, f.minScale, f.maxScale);
  return {
    scale,
    tx: clampAxis(v.tx, f.box.width, f.content.width * scale),
    ty: clampAxis(v.ty, f.box.height, f.content.height * scale),
  };
}

/**
 * Clamp a view to legal bounds: scale into [min,max], and — so the content can
 * never be dragged off the viewport — translation into
 * [box·(1−scale), 0] on each axis. At scale 1 the content exactly fills the
 * box, so it snaps back to the origin.
 */
export function clampView(v: View, box: Box, min = MIN_SCALE, max = MAX_SCALE): View {
  return clampViewIn(boxFrame(box, min, max), v);
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
export function zoomAboutIn(f: Frame, v: View, boxX: number, boxY: number, nextScale: number): View {
  const scale = clamp(nextScale, f.minScale, f.maxScale);
  const { cx, cy } = contentPointUnder(v, boxX, boxY);
  return clampViewIn(f, { scale, tx: boxX - cx * scale, ty: boxY - cy * scale });
}

export function zoomAbout(v: View, box: Box, boxX: number, boxY: number, nextScale: number): View {
  return zoomAboutIn(boxFrame(box), v, boxX, boxY, nextScale);
}

/** Zoom about the viewport centre (what the +/− buttons do). */
export function zoomByCenterIn(f: Frame, v: View, factor: number): View {
  return zoomAboutIn(f, v, f.box.width / 2, f.box.height / 2, v.scale * factor);
}

export function zoomByCenter(v: View, box: Box, factor: number): View {
  return zoomByCenterIn(boxFrame(box), v, factor);
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
export function pinchViewIn(f: Frame, start: PinchStart, midX: number, midY: number, dist: number): View {
  const scale = clamp((start.scale * dist) / (start.dist || 1), f.minScale, f.maxScale);
  return clampViewIn(f, { scale, tx: midX - start.cx * scale, ty: midY - start.cy * scale });
}

export function pinchView(start: PinchStart, box: Box, midX: number, midY: number, dist: number): View {
  return pinchViewIn(boxFrame(box), start, midX, midY, dist);
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

/**
 * One incremental step of a drag-to-pan, reporting the vertical movement the
 * pan could NOT absorb. `dx`/`dy` are the pointer deltas since the previous
 * move; the returned `view` is clamped to the frame. `overflowY` is the part of
 * `dy` that fell outside the pan's range — zero while the content still has room
 * to travel, the whole of `dy` when there is nothing to pan (content fits) or
 * once a top/bottom edge is reached. Callers chain that overflow into the
 * surrounding scroller so a drag that saturates the preview keeps scrolling the
 * panel, and vice versa.
 */
export function panStepIn(f: Frame, v: View, dx: number, dy: number): { view: View; overflowY: number } {
  const view = clampViewIn(f, { scale: v.scale, tx: v.tx + dx, ty: v.ty + dy });
  return { view, overflowY: dy - (view.ty - v.ty) };
}

export function panStep(v: View, box: Box, dx: number, dy: number): { view: View; overflowY: number } {
  return panStepIn(boxFrame(box), v, dx, dy);
}

/** Whether the view is at rest (100%, no offset) — e.g. to disable "reset". */
export function isIdentity(v: View): boolean {
  return v.scale === 1 && v.tx === 0 && v.ty === 0;
}
