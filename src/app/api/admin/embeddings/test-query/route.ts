import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApi, ApiError } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { runSearch } from "@/lib/embeddings/search";
import { embeddingEnabled } from "@/lib/embeddings/settings";

export const runtime = "nodejs";

const BodySchema = z.object({ query: z.string().min(1).max(300) });

/** Admin test-query box (docs/SEARCH_DESIGN.md §10): a normal whole-church
 *  search (admin scope = everything, per the §6.3 matrix — stated, not
 *  implicit) with SCORES VISIBLE — the only place scores render, for tuning
 *  the match threshold next to its knob. */
export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const adminId = await requireAdmin();
    if (!(await embeddingEnabled())) throw new ApiError(404, "Not found");
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid query");
    const result = await runSearch({
      userId: adminId,
      isRoleHolder: true,
      query: parsed.data.query,
      types: ["receipt", "claim"],
      scope: "all",
      adminScores: true,
    });
    return NextResponse.json(result);
  });
}
