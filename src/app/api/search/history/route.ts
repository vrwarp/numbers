import { NextResponse } from "next/server";
import { requireUserId, handleApi } from "@/lib/api";
import { listSearchHistory, clearSearchHistory } from "@/lib/embeddings/history";

export const runtime = "nodejs";

/**
 * The user's own recent-search history (docs/SEARCH_DESIGN.md §7): read to seed
 * the "Recent searches" dropdown, DELETE to clear it. Strictly owner-scoped
 * (hard invariant 2) — history is written by POST /api/search, so there is no
 * write endpoint here. Not gated on the embedding master switch: a member's own
 * past queries are theirs to see regardless of search availability.
 */
export async function GET() {
  return handleApi(async () => {
    const userId = await requireUserId();
    return NextResponse.json({ recents: await listSearchHistory(userId) });
  });
}

export async function DELETE() {
  return handleApi(async () => {
    const userId = await requireUserId();
    await clearSearchHistory(userId);
    return NextResponse.json({ ok: true });
  });
}
