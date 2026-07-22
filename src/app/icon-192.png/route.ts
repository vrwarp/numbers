import { renderBrandIcon } from "@/lib/brand/icons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Favicon + PWA 192px icon, served as a ROUTE (not a static public/ file) so
 * the CANARY marker can repaint it at runtime — see src/lib/brand/icons.ts.
 * Short revalidate: browsers cache favicons hard, and a canary toggle should
 * surface within minutes without being re-fetched on every navigation.
 */
export async function GET() {
  const body = await renderBrandIcon("icon-192");
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300, must-revalidate",
    },
  });
}
