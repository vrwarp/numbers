import { prisma } from "@/lib/prisma";

/**
 * Per-user recent-search history (docs/SEARCH_DESIGN.md §7). Stored server-side
 * so the "Recent searches" dropdown follows the member across devices. This is
 * the user's own history shown back to them, strictly owner-scoped (hard
 * invariant 2) — it is NOT telemetry, so it never touches ExtractionLogs
 * (invariant 11's "queries never logged" posture is unchanged).
 */

// How far back the history reaches. Rows older than this are pruned on write
// and filtered on read, so the window holds even if a prune is ever missed.
export const SEARCH_HISTORY_WINDOW_DAYS = 90;
// How many recents the dropdown shows (matches the old localStorage cap).
export const SEARCH_HISTORY_LIMIT = 5;

const WINDOW_MS = SEARCH_HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Record a query in the user's recents, best-effort. One row per distinct
 * query — re-searching bumps it to the top via @updatedAt — and anything past
 * the 90-day window is pruned in the same call. Never throws into the search
 * path: history is a convenience, not part of the search contract.
 */
export async function recordSearchHistory(userId: string, query: string): Promise<void> {
  const q = query.trim();
  if (!q) return;
  try {
    await prisma.searchHistory.upsert({
      where: { userId_query: { userId, query: q } },
      create: { userId, query: q },
      // Touch a field so @updatedAt fires and the entry floats to the top.
      update: { query: q },
    });
    await prisma.searchHistory.deleteMany({
      where: { userId, updatedAt: { lt: new Date(Date.now() - WINDOW_MS) } },
    });
  } catch {
    // A history write must never fail a search.
  }
}

/** The user's most-recent queries within the window, newest first. */
export async function listSearchHistory(userId: string): Promise<string[]> {
  const rows = await prisma.searchHistory.findMany({
    where: { userId, updatedAt: { gte: new Date(Date.now() - WINDOW_MS) } },
    orderBy: { updatedAt: "desc" },
    take: SEARCH_HISTORY_LIMIT,
    select: { query: true },
  });
  return rows.map((r) => r.query);
}

/** Drop the user's entire search history (the "Clear" affordance). */
export async function clearSearchHistory(userId: string): Promise<void> {
  await prisma.searchHistory.deleteMany({ where: { userId } });
}
