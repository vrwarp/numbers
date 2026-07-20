import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { teamPrefetch } from "@/lib/teams-catalog";
import { sha256Hex } from "./content";
import { embeddingSettings, modelConfigOf } from "./settings";
import { embedText } from "./provider";
import { normalizeQuery } from "./normalize";
import { cachedQueryVector, storeQueryVector } from "./query-cache";
import { indexEntries, dot, type IndexEntry } from "./index-cache";
import { exactMatchPass, type ExactScope } from "./exact";
import { formatMinistryEvent } from "@/lib/ministries";
import { appTimeZone } from "@/lib/config";
import { zonedYear } from "@/lib/timezone";

/** The search engine behind POST /api/search (docs/SEARCH_DESIGN.md §6). */

export type SearchTypes = ("receipt" | "claim")[];
export type SearchScopeName = "mine" | "all" | "decided" | "team";

export type ReceiptItem = {
  kind: "receipt";
  id: string;
  score?: number;
  merchant: string;
  purchaseDate: string;
  note: string;
  mimeType: string;
  ownerName?: string;
  ownerId: string;
  year: number;
  claims: { id: string; status: string }[];
};
export type ClaimItem = {
  kind: "claim";
  id: string;
  score?: number;
  status: string;
  totalCents: number;
  claimDescription: string;
  ministries: string[];
  ownerName?: string;
  ownerId: string;
  approverUserId: string | null;
  year: number;
  createdAt: string;
};
export type SearchItem = ReceiptItem | ClaimItem;

export type SearchResult = {
  exact: SearchItem[];
  exactTotal: number;
  best: SearchItem | null;
  groups: { year: number; items: SearchItem[] }[];
  indexed: {
    myPendingReceipts: number;
    myPendingClaims: number;
    myNextReadyAt?: string;
    rebuildPending?: number;
  };
  degraded?: "semanticUnavailable";
  nextCursor?: string;
};

const TOP_K = 50;
const BROWSE_PAGE = 20;

export async function decidedPrefetch(userId: string) {
  const claims = await prisma.reimbursement.findMany({
    where: { approverUserId: userId, status: { in: ["approved", "rejected", "paid"] } },
    select: { id: true, receipts: { select: { receiptId: true } } },
  });
  return {
    claimIds: claims.map((c) => c.id),
    receiptIds: [...new Set(claims.flatMap((c) => c.receipts.map((r) => r.receiptId)))],
  };
}

/** Per-kind scope constraints re-applied at hydration (§6.1 step 6): `mine`
 *  restricts by owner, `team` by the prefetched allowed-id sets, `all` is
 *  genuinely unrestricted. An index-cache bug can never leak a row the DB
 *  query itself excludes. */
type ScopeWheres = {
  receipt: Prisma.ReceiptWhereInput;
  claim: Prisma.ReimbursementWhereInput;
};

async function hydrate(
  receiptIds: string[],
  claimIds: string[],
  scopeWheres: ScopeWheres,
  includeOwner: boolean
): Promise<Map<string, SearchItem>> {
  const out = new Map<string, SearchItem>();
  if (receiptIds.length) {
    const rows = await prisma.receipt.findMany({
      where: { AND: [{ id: { in: receiptIds } }, scopeWheres.receipt] },
      include: {
        user: includeOwner ? { select: { fullName: true, email: true } } : undefined,
        reimbursements: {
          select: { reimbursement: { select: { id: true, status: true } } },
        },
      },
    });
    for (const r of rows) {
      out.set(`receipt:${r.id}`, {
        kind: "receipt",
        id: r.id,
        merchant: r.merchant,
        purchaseDate: r.purchaseDate,
        note: r.note,
        mimeType: r.mimeType,
        ownerId: r.userId,
        year: /^(\d{4})-/.test(r.purchaseDate)
          ? Number(r.purchaseDate.slice(0, 4))
          : zonedYear(r.createdAt, appTimeZone()),
        ownerName: includeOwner
          ? r.user?.fullName || r.user?.email || undefined
          : undefined,
        claims: r.reimbursements.map((j) => ({
          id: j.reimbursement.id,
          status: j.reimbursement.status,
        })),
      });
    }
  }
  if (claimIds.length) {
    const rows = await prisma.reimbursement.findMany({
      where: { AND: [{ id: { in: claimIds } }, scopeWheres.claim] },
      include: {
        user: { select: { fullName: true, email: true } },
        lineItems: { where: { isExcluded: false }, select: { ministry: true, event: true } },
      },
    });
    for (const c of rows) {
      out.set(`claim:${c.id}`, {
        kind: "claim",
        id: c.id,
        status: c.status,
        totalCents: c.totalCents,
        claimDescription: c.claimDescription,
        ministries: [
          ...new Set(
            c.lineItems
              .map((i) => formatMinistryEvent(i.ministry, i.event))
              .filter(Boolean)
          ),
        ].slice(0, 3),
        ownerName: includeOwner ? c.user.fullName || c.user.email : undefined,
        ownerId: c.userId,
        approverUserId: c.approverUserId,
        year: zonedYear(c.submittedAt ?? c.createdAt, appTimeZone()),
        createdAt: c.createdAt.toISOString(),
      });
    }
  }
  return out;
}

/** Items arrive already ranked (score desc / recency for browse); grouping
 *  preserves that order within each year, newest year first. */
function groupByYear(items: SearchItem[]): { year: number; items: SearchItem[] }[] {
  const byYear = new Map<number, SearchItem[]>();
  for (const item of items) {
    const list = byYear.get(item.year) ?? [];
    list.push(item);
    byYear.set(item.year, list);
  }
  return [...byYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, list]) => ({ year, items: list }));
}

async function pendingCounts(userId: string): Promise<SearchResult["indexed"]> {
  const [mine, rebuild] = await Promise.all([
    prisma.embeddingJob.findMany({
      where: { userId, status: { in: ["queued", "running"] } },
      select: { kind: true, nextAttemptAt: true },
    }),
    prisma.embeddingJob.count({
      where: { priority: 1, status: { in: ["queued", "running"] } },
    }),
  ]);
  const myPendingReceipts = mine.filter((j) => j.kind === "receipt").length;
  const myPendingClaims = mine.filter((j) => j.kind === "claim").length;
  const nexts = mine
    .filter((j) => j.kind === "claim")
    .map((j) => j.nextAttemptAt.getTime());
  return {
    myPendingReceipts,
    myPendingClaims,
    ...(nexts.length
      ? { myNextReadyAt: new Date(Math.min(...nexts)).toISOString() }
      : {}),
    // Aggregate exception (§6.3): coarse, only while a rebuild/backfill runs.
    ...(rebuild > 0 ? { rebuildPending: Math.max(10, Math.round(rebuild / 10) * 10) } : {}),
  };
}

export async function runSearch(opts: {
  userId: string;
  isRoleHolder: boolean;
  query: string;
  types: SearchTypes;
  scope: SearchScopeName;
  cursor?: string;
  adminScores?: boolean;
}): Promise<SearchResult> {
  const { userId, query, types, scope } = opts;
  const settings = await embeddingSettings();
  if (!settings) throw new Error("search unconfigured"); // route 404s before this

  const decided = scope === "decided" ? await decidedPrefetch(userId) : null;
  // Team scope (§6.3 team amendment): allowed-id sets from live membership —
  // receipts whose own line item carries a team code on a non-draft claim,
  // plus the containing claims.
  const team = scope === "team" ? await teamPrefetch(userId) : null;
  const scopeWheres: ScopeWheres =
    scope === "mine"
      ? { receipt: { userId }, claim: { userId } }
      : scope === "team"
        ? {
            receipt: { id: { in: team!.receiptIds } },
            claim: { id: { in: team!.claimIds } },
          }
        : { receipt: {}, claim: {} };
  const includeOwner = scope !== "mine";

  // Browse mode: decided scope + empty query = the decided set newest-first.
  if (scope === "decided" && !normalizeQuery(query)) {
    const offset = Number(opts.cursor ?? 0) || 0;
    const ids = decided!.claimIds;
    const page = await prisma.reimbursement.findMany({
      where: { id: { in: ids } },
      orderBy: { decidedAt: "desc" },
      skip: offset,
      take: BROWSE_PAGE,
      select: { id: true },
    });
    const hydrated = await hydrate([], page.map((c) => c.id), scopeWheres, true);
    const items = page
      .map((c) => hydrated.get(`claim:${c.id}`))
      .filter((x): x is SearchItem => !!x);
    return {
      exact: [],
      exactTotal: 0,
      best: null,
      groups: groupByYear(items),
      indexed: await pendingCounts(userId),
      ...(offset + BROWSE_PAGE < ids.length
        ? { nextCursor: String(offset + BROWSE_PAGE) }
        : {}),
    };
  }

  // Browse mode: team scope + empty query = the team's receipts newest-first
  // ("list all the receipts under my teams' budgets"). Claims join in only on
  // an actual query — the browse list keeps the receipt as the spine.
  if (scope === "team" && !normalizeQuery(query)) {
    const offset = Number(opts.cursor ?? 0) || 0;
    const ids = team!.receiptIds;
    const page = await prisma.receipt.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: BROWSE_PAGE,
      select: { id: true },
    });
    const hydrated = await hydrate(page.map((r) => r.id), [], scopeWheres, true);
    const items = page
      .map((r) => hydrated.get(`receipt:${r.id}`))
      .filter((x): x is SearchItem => !!x);
    return {
      exact: [],
      exactTotal: 0,
      best: null,
      groups: groupByYear(items),
      indexed: await pendingCounts(userId),
      ...(offset + BROWSE_PAGE < ids.length
        ? { nextCursor: String(offset + BROWSE_PAGE) }
        : {}),
    };
  }

  const exactScope: ExactScope =
    scope === "mine"
      ? { kind: "mine", userId }
      : scope === "decided"
        ? { kind: "decided", ...decided! }
        : scope === "team"
          ? { kind: "team", ...team! }
          : { kind: "all" };
  const exactRaw = await exactMatchPass(query, exactScope, types);

  // Semantic pass — degraded (exact-only) when the embed call fails.
  let scored: { entry: IndexEntry; score: number }[] = [];
  let degraded = false;
  const normalized = normalizeQuery(query);
  const lruKey = [settings.model, settings.queryPrefix, normalized].join("␟");
  try {
    let qv = cachedQueryVector(lruKey);
    if (!qv) {
      const t0 = Date.now();
      try {
        qv = await embedText(settings.queryPrefix + query, modelConfigOf(settings));
        await prisma.extractionLog.create({
          data: {
            userId,
            kind: "embedding",
            model: settings.model,
            prompt: "query",
            parsedJson: JSON.stringify({
              dim: qv.length,
              promptSha256: sha256Hex(normalized),
              promptChars: query.length,
            }),
            status: "success",
            durationMs: Date.now() - t0,
          },
        });
      } catch (err) {
        await prisma.extractionLog
          .create({
            data: {
              userId,
              kind: "embedding",
              model: settings.model,
              prompt: "query",
              parsedJson: JSON.stringify({
                promptSha256: sha256Hex(normalized),
                promptChars: query.length,
              }),
              status: "error",
              errorMessage: String(err).slice(0, 500),
              durationMs: Date.now() - t0,
            },
          })
          .catch(() => {});
        throw err;
      }
      storeQueryVector(lruKey, qv);
    }
    const entries = await indexEntries(settings.model);
    const decidedClaims = decided ? new Set(decided.claimIds) : null;
    const decidedReceipts = decided ? new Set(decided.receiptIds) : null;
    const teamClaims = team ? new Set(team.claimIds) : null;
    const teamReceipts = team ? new Set(team.receiptIds) : null;
    const minScore = settings.minScoreMilli / 1000;
    for (const entry of entries) {
      if (!types.includes(entry.kind)) continue;
      // Tenant scoping is a PRE-filter, never post (§6.1 step 4).
      if (scope === "mine" && entry.userId !== userId) continue;
      if (scope === "decided") {
        const set = entry.kind === "claim" ? decidedClaims! : decidedReceipts!;
        if (!set.has(entry.targetId)) continue;
      }
      if (scope === "team") {
        const set = entry.kind === "claim" ? teamClaims! : teamReceipts!;
        if (!set.has(entry.targetId)) continue;
      }
      const score = dot(qv, entry.vector);
      if (score >= minScore) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    scored = scored.slice(0, TOP_K);
  } catch {
    degraded = true;
  }

  // Dedupe semantic hits already present in exact.
  const exactKeys = new Set([
    ...exactRaw.receiptIds.map((id) => `receipt:${id}`),
    ...exactRaw.claimIds.map((id) => `claim:${id}`),
  ]);
  const semantic = scored.filter(
    (s) => !exactKeys.has(`${s.entry.kind}:${s.entry.targetId}`)
  );

  const hydrated = await hydrate(
    [...exactRaw.receiptIds, ...semantic.filter((s) => s.entry.kind === "receipt").map((s) => s.entry.targetId)],
    [...exactRaw.claimIds, ...semantic.filter((s) => s.entry.kind === "claim").map((s) => s.entry.targetId)],
    scopeWheres,
    includeOwner
  );

  const exactItems = [...exactRaw.receiptIds.map((id) => `receipt:${id}`), ...exactRaw.claimIds.map((id) => `claim:${id}`)]
    .map((k) => hydrated.get(k))
    .filter((x): x is SearchItem => !!x);

  const semanticItems = semantic
    .map((s) => {
      const item = hydrated.get(`${s.entry.kind}:${s.entry.targetId}`);
      if (!item) return null; // hydration re-applied scope: index bug can't leak
      return { ...item, ...(opts.adminScores ? { score: s.score } : {}) };
    })
    .filter((x): x is SearchItem => !!x);

  // Pin the top hit ONLY when exact is empty (§6.1 step 5).
  let best: SearchItem | null = null;
  let grouped = semanticItems;
  if (!exactItems.length && semanticItems.length) {
    best = semanticItems[0];
    grouped = semanticItems.slice(1);
  }

  const groups = groupByYear(grouped);

  return {
    exact: exactItems,
    exactTotal: exactItems.length,
    best,
    groups,
    indexed: await pendingCounts(userId),
    ...(degraded ? { degraded: "semanticUnavailable" as const } : {}),
  };
}
