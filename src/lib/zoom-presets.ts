import { fitScales, type Box } from "@/lib/esign/viewport";

/**
 * Zoom presets for the inline receipt viewer's third pill button (beside −/+):
 * fit the photo's height, fit its width, or jump to 2× the tighter fit. Pure
 * so the cycling rules are unit-testable without a DOM.
 */

export type ZoomPresetKind = "fitImage" | "fitHeight" | "fitWidth" | "zoom2x";

export interface ZoomPreset {
  kind: ZoomPresetKind;
  scale: number;
}

/** Two scales count as the same stop within 1% — sub-pixel layout noise. */
const same = (a: number, b: number) => Math.abs(a - b) <= 0.01 * Math.max(a, b);

/**
 * The cycle, ascending: the contain fit first (also the viewer's initial
 * state — whichever axis fit shows the whole image), then the other axis's
 * fit, then 2× the more zoomed-in of the two fits. When both axes fit at the
 * same scale the two fits collapse into one "fit whole image" stop.
 */
export function zoomPresets(box: Box, content: Box): ZoomPreset[] {
  const { fitWidth, fitHeight } = fitScales(box, content);
  const twoX: ZoomPreset = { kind: "zoom2x", scale: 2 * Math.max(fitWidth, fitHeight) };
  if (same(fitWidth, fitHeight)) {
    return [{ kind: "fitImage", scale: Math.min(fitWidth, fitHeight) }, twoX];
  }
  const fits: ZoomPreset[] = [
    { kind: "fitHeight", scale: fitHeight },
    { kind: "fitWidth", scale: fitWidth },
  ];
  fits.sort((a, b) => a.scale - b.scale);
  return [...fits, twoX];
}

/**
 * The preset a press of the button should apply: the stop after the one the
 * view currently sits on — or, from any freehand zoom level, back to the
 * whole-image fit (the cycle's first stop).
 */
export function nextPreset(box: Box, content: Box, scale: number): ZoomPreset {
  const presets = zoomPresets(box, content);
  const at = presets.findIndex((p) => same(p.scale, scale));
  return at === -1 ? presets[0] : presets[(at + 1) % presets.length];
}
