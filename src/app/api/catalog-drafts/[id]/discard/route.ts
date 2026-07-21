import { NextResponse } from "next/server";
import { requireUserId, handleApi } from "@/lib/api";
import { discardCatalogDraft } from "@/lib/catalog-drafts";

export const runtime = "nodejs";

/** Discard a pending catalog-edit draft (its author or a manager of its entity). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    return NextResponse.json(await discardCatalogDraft(userId, id));
  });
}
