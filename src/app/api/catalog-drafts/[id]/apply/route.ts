import { NextResponse } from "next/server";
import { requireUserId, handleApi } from "@/lib/api";
import { applyCatalogDraft } from "@/lib/catalog-drafts";

export const runtime = "nodejs";

/** Apply a pending catalog-edit draft — the human action from the review page.
 *  Re-checks the manage role, performs the change, and audits it. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    return NextResponse.json(await applyCatalogDraft(userId, id));
  });
}
