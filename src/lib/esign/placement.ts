/**
 * Signature placement (docs/ESIGN_DESIGN.md — click-to-stamp). Where a
 * signer dropped their signature on the document, as page-normalized
 * ratios in PDF bottom-left origin so it maps cleanly onto both a
 * browser canvas and a pdf-lib page regardless of resolution. Dependency-
 * free and client-safe: it rides inside signed ceremony payloads, so the
 * *position* of each signature is part of the cryptographic record.
 */

export interface SignaturePlacement {
  /** Packet page index the signature sits on (0 = first form page). */
  page: number;
  /** Bottom-left corner of the stamp, as a fraction of page width/height. */
  xRatio: number;
  yRatio: number;
  /** Stamp width as a fraction of page width; height follows the image aspect. */
  widthRatio: number;
}

/** A form text field's rectangle, page-normalized (bottom-left origin) — lets
 *  the signing preview overlay the printed name/date exactly where the
 *  certificate route stamps them. */
export interface FieldAnchor {
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
}

/** 4-decimal rounding so client and server serialize byte-identically
 *  (canonicalStringify hashes the exact numbers — no drift allowed). */
export function roundPlacement(p: SignaturePlacement): SignaturePlacement {
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  return { page: p.page | 0, xRatio: r(p.xRatio), yRatio: r(p.yRatio), widthRatio: r(p.widthRatio) };
}

export function placementsEqual(a?: SignaturePlacement, b?: SignaturePlacement): boolean {
  if (!a || !b) return a === b;
  return a.page === b.page && a.xRatio === b.xRatio && a.yRatio === b.yRatio && a.widthRatio === b.widthRatio;
}

export function clampPlacement(p: SignaturePlacement, aspect: number): SignaturePlacement {
  const widthRatio = Math.min(0.6, Math.max(0.06, p.widthRatio));
  const heightRatio = widthRatio * aspect; // aspect = imgH/imgW in page-ratio terms handled by caller
  const xRatio = Math.min(1 - widthRatio, Math.max(0, p.xRatio));
  const yRatio = Math.min(1 - heightRatio, Math.max(0, p.yRatio));
  return { page: p.page, xRatio, yRatio, widthRatio };
}

/**
 * Cap a stamp's width so its rendered height stays within `maxHeightRatio`
 * (a fraction of page height), preserving the image's aspect. `heightPerWidth`
 * is the stamp height as a fraction of page height per unit of widthRatio —
 * i.e. imgAspect × pageWidth / pageHeight. The signature is stamped at a fixed
 * column width, so a compact mark (a near-square doodle) would balloon
 * vertically off the line; this trades width away to keep it sitting on the
 * line. Only ever narrows — never widens.
 */
export function fitWidthToHeight(
  widthRatio: number,
  heightPerWidth: number,
  maxHeightRatio: number
): number {
  if (heightPerWidth <= 0 || maxHeightRatio <= 0) return widthRatio;
  return Math.min(widthRatio, maxHeightRatio / heightPerWidth);
}
