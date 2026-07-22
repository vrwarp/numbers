import { renderBrandIcon } from "@/lib/brand/icons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** iOS home-screen icon (180px) — CANARY-aware, see src/lib/brand/icons.ts. */
export async function GET() {
  const body = await renderBrandIcon("apple-touch-icon");
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300, must-revalidate",
    },
  });
}
