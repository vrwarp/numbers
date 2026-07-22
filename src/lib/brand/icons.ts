import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { isCanary, CANARY_THEME_COLOR } from "./canary";

/**
 * Runtime brand-icon renderer. The base PNGs live under assets/brand/ (shipped
 * in the Docker image beside the PDF template, read via process.cwd() like the
 * fonts). Because the canary marker is a runtime toggle — not a build-time one
 * — the favicon / PWA / apple-touch icons can't be plain static files: each is
 * served by a route (src/app/<name>/route.ts) that calls in here.
 *
 * When not canary the base bytes pass through untouched (byte-for-byte the old
 * public/ files). When canary a solid amber corner flag is composited on — a
 * font-free SVG (pure shapes, no text/emoji) so it renders identically in any
 * headless environment, and legible even shrunk to a 16px favicon.
 */

export type BrandIcon = "icon-192" | "icon-512" | "apple-touch-icon";

// pixel dimensions of each base asset (the overlay must match exactly).
const SIZES: Record<BrandIcon, number> = {
  "icon-192": 192,
  "icon-512": 512,
  "apple-touch-icon": 180,
};

function baseFile(name: BrandIcon): string {
  return path.join(process.cwd(), "assets", "brand", `${name}.png`);
}

/** A canary corner flag: an amber triangle over the bottom-right corner with a
 *  thin white keyline so it reads against any base. Sized to the icon so it
 *  scales proportionally at every resolution. */
function canaryFlag(size: number): Buffer {
  const start = Math.round(size * 0.5); // corner triangle covers ~quarter area
  const stroke = Math.max(2, Math.round(size * 0.02));
  const tri = `M ${size} ${start} L ${size} ${size} L ${start} ${size} Z`;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<path d="${tri}" fill="${CANARY_THEME_COLOR}" stroke="#ffffff" stroke-width="${stroke}" stroke-linejoin="round"/>` +
      `</svg>`
  );
}

// Both states are cached after first render (keyed by canary flag), so a config
// toggle recomputes at most once. Buffers are immutable, safe to share.
const cache = new Map<string, Buffer>();

export async function renderBrandIcon(name: BrandIcon): Promise<Buffer> {
  const canary = isCanary();
  const key = `${name}:${canary ? "1" : "0"}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const base = await fs.readFile(baseFile(name));
  const out = canary
    ? await sharp(base)
        .composite([{ input: canaryFlag(SIZES[name]), top: 0, left: 0 }])
        .png()
        .toBuffer()
    : base;

  cache.set(key, out);
  return out;
}
