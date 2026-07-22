import { renderBrandIcon } from "@/lib/brand/icons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PWA 512px (maskable) icon — CANARY-aware, see src/lib/brand/icons.ts. */
export async function GET() {
  const body = await renderBrandIcon("icon-512");
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300, must-revalidate",
    },
  });
}
