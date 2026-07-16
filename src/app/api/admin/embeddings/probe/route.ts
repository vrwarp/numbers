import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApi, ApiError } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { embeddingSettings } from "@/lib/embeddings/settings";
import { probeEndpoint, EmbedError } from "@/lib/embeddings/provider";

export const runtime = "nodejs";

const BodySchema = z.object({
  endpoint: z.string().max(300).optional(),
  apiKey: z.string().max(300).optional(),
  model: z.string().max(100).optional(),
});

/** "Test connection" (docs/SEARCH_DESIGN.md §10): the standalone save-time
 *  probe — 10 s timeout, returns the DETECTED dimension + latency. Field
 *  overrides let the admin test values before saving; the stored key fills
 *  any blank. */
export async function POST(req: NextRequest) {
  return handleApi(async () => {
    await requireAdmin();
    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) throw new ApiError(400, "Invalid probe request");
    const current = await embeddingSettings();
    const cfg = {
      endpoint: (parsed.data.endpoint ?? current?.endpoint ?? "").trim(),
      apiKey: parsed.data.apiKey?.trim() || current?.apiKey || "",
      model: (parsed.data.model ?? current?.model ?? "").trim(),
    };
    if (!cfg.endpoint) throw new ApiError(400, "Endpoint is required");
    try {
      const result = await probeEndpoint(cfg);
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      throw new ApiError(
        502,
        err instanceof EmbedError ? err.message : "Connection test failed",
        "embeddingProbeFailed"
      );
    }
  });
}
