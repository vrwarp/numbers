import { NextResponse } from "next/server";
import { isCanary, CANARY_THEME_COLOR, DEFAULT_THEME_COLOR } from "@/lib/brand/canary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PWA web manifest, served as a ROUTE so the CANARY marker can rename the
 * installed app and repaint its theme color at runtime (a static public/ file
 * can't — see the icon routes / src/lib/brand/icons.ts). The name/description
 * are the deployment's own English brand strings, deliberately outside the
 * next-intl catalogs (a manifest is single-locale), matching the file it
 * replaced. short_name stays exactly "Numbers" off-canary — an installed
 * home-screen label the mobile e2e asserts.
 */
export function GET() {
  const canary = isCanary();
  const manifest = {
    name: canary ? "Numbers (Canary) — CFCC Reimbursements" : "Numbers — CFCC Reimbursements",
    short_name: canary ? "Numbers 🐤" : "Numbers",
    description: "Snap church receipts now, submit reimbursement claims later.",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f5f4",
    theme_color: canary ? CANARY_THEME_COLOR : DEFAULT_THEME_COLOR,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  };
  return NextResponse.json(manifest, {
    headers: {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "public, max-age=300, must-revalidate",
    },
  });
}
