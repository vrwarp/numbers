import { NextRequest, NextResponse } from "next/server";
import { requireUserId, handleApi } from "@/lib/api";
import { listCatalogDrafts, manageableEntities, type CatalogEntity } from "@/lib/catalog-drafts";

export const runtime = "nodejs";

/**
 * Pending catalog-edit drafts the caller may act on (docs/MCP_DESIGN.md) — for
 * entities they manage, plus any they authored — for the Proposed Changes
 * review page. `manageable` tells the page which entity sections to show.
 */
export async function GET(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const entityParam = req.nextUrl.searchParams.get("entity");
    const entity =
      entityParam === "ministry" || entityParam === "team" || entityParam === "position"
        ? (entityParam as CatalogEntity)
        : undefined;
    const [drafts, manageable] = await Promise.all([
      listCatalogDrafts(userId, { entity }),
      manageableEntities(userId),
    ]);
    return NextResponse.json({ drafts, manageable });
  });
}
