import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { hasRoleReadGrant } from "@/lib/roles";
import { embeddingEnabled } from "@/lib/embeddings/settings";
import { runSearch } from "@/lib/embeddings/search";

export const runtime = "nodejs";

const BodySchema = z.object({
  query: z.string().max(300).default(""),
  types: z.array(z.enum(["receipt", "claim"])).min(1).max(2).optional(),
  scope: z.enum(["mine", "all", "decided"]).optional(),
  cursor: z.string().max(20).optional(),
});

/**
 * Semantic + exact search (docs/SEARCH_DESIGN.md §6.1). POST because queries
 * are user content and must not land in access logs. Role-holders default to
 * whole-church scope; members asking for all/decided get the standard 404
 * (indistinguishable from not-found, hard invariant 2).
 */
export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    if (!(await embeddingEnabled())) throw new ApiError(404, "Not found");
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid search request");

    const isRoleHolder = await hasRoleReadGrant(userId);
    const scope = parsed.data.scope ?? (isRoleHolder ? "all" : "mine");
    if (!isRoleHolder && scope !== "mine") throw new ApiError(404, "Not found");
    if (!parsed.data.query.trim() && scope !== "decided") {
      throw new ApiError(400, "Empty query");
    }

    const result = await runSearch({
      userId,
      isRoleHolder,
      query: parsed.data.query,
      types: parsed.data.types ?? ["receipt", "claim"],
      scope,
      cursor: parsed.data.cursor,
    });
    return NextResponse.json(result);
  });
}
