"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { formatCents } from "@/lib/money";
import { useApiErrorMessage } from "@/lib/use-api-error";

/**
 * The /search screen (docs/SEARCH_DESIGN.md §7): explicit-submit search with
 * an IME-safe Enter guard, an exact-match strip (≤3 + show all), a Best-match
 * pin only when no exact hits, year-grouped semantic results, per-kind pending
 * notes, degraded mode, device-local recents, and sessionStorage restore.
 */

type ReceiptItem = {
  kind: "receipt";
  id: string;
  merchant: string;
  purchaseDate: string;
  note: string;
  mimeType: string;
  ownerName?: string;
  ownerId: string;
  year: number;
  claims: { id: string; status: string }[];
};
type ClaimItem = {
  kind: "claim";
  id: string;
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
type Item = ReceiptItem | ClaimItem;
type SearchResponse = {
  exact: Item[];
  exactTotal: number;
  best: Item | null;
  groups: { year: number; items: Item[] }[];
  indexed: {
    myPendingReceipts: number;
    myPendingClaims: number;
    myNextReadyAt?: string;
    rebuildPending?: number;
  };
  degraded?: "semanticUnavailable";
  nextCursor?: string;
};

type Scope = "mine" | "all" | "decided";
type TypeFilter = "receipt" | "claim" | null;

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-amber-100 text-amber-800",
  generated: "bg-emerald-100 text-emerald-800",
  submitted: "bg-sky-100 text-sky-800",
  rejected: "bg-red-100 text-red-800",
  approved: "bg-emerald-100 text-emerald-800",
  paid: "bg-indigo-100 text-indigo-800",
};

// Per-locale relative-date tokens (code, not translated copy — §7.2): when the
// query contains one and results span years, a hint explains that search
// matches descriptions, not dates.
const RELATIVE_DATE_TOKENS =
  /(last (month|year|week)|yesterday|上个月|上個月|去年|昨天|前天|上周|上週|今年)/i;

function statusKey(status: string): string {
  return status === "draft" ? "needsReview" : status;
}

export default function SearchClient({
  userId,
  canAll,
  canDecided,
}: {
  userId: string;
  // Cross-tenant search capabilities (docs/SEARCH_DESIGN.md §6.3): the verified
  // role narrowed by the A10 duty pauses. canAll → whole-church scope; canDecided
  // → the "Claims I decided" browse (implies canAll).
  canAll: boolean;
  canDecided: boolean;
}) {
  const t = useTranslations("Search");
  const tStatus = useTranslations("Common.status");
  const format = useFormatter();
  const router = useRouter();
  const params = useSearchParams();
  const errorMessage = useApiErrorMessage();

  const storageKey = `numbers.search.${userId}`;
  const recentsKey = `numbers.search.recents.${userId}`;

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>(canAll ? "all" : "mine");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllExact, setShowAllExact] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const [announce, setAnnounce] = useState("");
  const submitSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastSearched = useRef<{ query: string; scope: Scope } | null>(null);

  // Entry pills pre-set the type (?type=receipt|claim) and focus the input —
  // the user just tapped something that looks like a search box (§7.1).
  useEffect(() => {
    const type = params.get("type");
    if (type === "receipt" || type === "claim") setTypeFilter(type);
    inputRef.current?.focus();
    // Restore the session's last search (Back from a result must not retype —
    // IME users pay the composition tax only once, §7.2).
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        const s = JSON.parse(saved);
        setQuery(s.query ?? "");
        // Only restore a scope this user is still allowed (pauses may have
        // changed since); otherwise fall back to the default already set.
        if (
          s.scope === "mine" ||
          (s.scope === "all" && canAll) ||
          (s.scope === "decided" && canDecided)
        ) {
          setScope(s.scope);
        }
        if (s.typeFilter === "receipt" || s.typeFilter === "claim") setTypeFilter(s.typeFilter);
        if (s.result) setResult(s.result);
        setShowAllExact(!!s.showAllExact);
        lastSearched.current = s.lastSearched ?? null;
      }
      const r = localStorage.getItem(recentsKey);
      if (r) setRecents(JSON.parse(r));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistSession = useCallback(
    (next: Partial<{ result: SearchResponse | null; showAllExact: boolean }>) => {
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({
            query,
            scope,
            typeFilter,
            result: next.result !== undefined ? next.result : result,
            showAllExact: next.showAllExact ?? showAllExact,
            lastSearched: lastSearched.current,
          })
        );
      } catch {}
    },
    [query, scope, typeFilter, result, showAllExact, storageKey]
  );

  const rememberRecent = useCallback(
    (q: string) => {
      if (!q.trim()) return;
      setRecents((prev) => {
        const next = [q, ...prev.filter((x) => x !== q)].slice(0, 5);
        try {
          localStorage.setItem(recentsKey, JSON.stringify(next));
        } catch {}
        return next;
      });
    },
    [recentsKey]
  );

  const runSearch = useCallback(
    async (
      q: string,
      opts: { scope?: Scope; type?: TypeFilter; cursor?: string; append?: boolean } = {}
    ) => {
      const useScope = opts.scope ?? scope;
      const useType = opts.type !== undefined ? opts.type : typeFilter;
      if (!q.trim() && useScope !== "decided") return;
      const seq = ++submitSeq.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setSearching(true);
      setSlow(false);
      setError(null);
      setAnnounce(t("searching"));
      const slowTimer = setTimeout(() => setSlow(true), 3000);
      try {
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: q,
            scope: useScope,
            ...(useType ? { types: [useType] } : {}),
            ...(opts.cursor ? { cursor: opts.cursor } : {}),
          }),
          signal: controller.signal,
        });
        if (seq !== submitSeq.current) return; // stale response
        if (!res.ok) {
          setError(errorMessage(await res.json().catch(() => null), t("searchFailed")));
          return;
        }
        const data = (await res.json()) as SearchResponse;
        if (seq !== submitSeq.current) return;
        lastSearched.current = { query: q, scope: useScope };
        const merged = opts.append && result
          ? { ...data, groups: mergeGroups(result.groups, data.groups) }
          : data;
        setResult(merged);
        setShowAllExact(false);
        rememberRecent(q);
        persistSession({ result: merged, showAllExact: false });
        const count =
          merged.exact.length +
          (merged.best ? 1 : 0) +
          merged.groups.reduce((s, g) => s + g.items.length, 0);
        setAnnounce(t("resultsAnnounce", { count }));
      } catch (err) {
        if ((err as Error).name !== "AbortError" && seq === submitSeq.current) {
          setError(t("searchFailed"));
        }
      } finally {
        clearTimeout(slowTimer);
        if (seq === submitSeq.current) {
          setSearching(false);
          setSlow(false);
        }
      }
    },
    [scope, typeFilter, result, t, errorMessage, rememberRecent, persistSession]
  );

  const onSubmit = useCallback(() => void runSearch(query), [runSearch, query]);

  // IME safety (§7.4): Enter while composing commits the composition buffer,
  // never fires a search — pinyin users typing 王姐妹 must not search "wang".
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      onSubmit();
    },
    [onSubmit]
  );

  const changeScope = useCallback(
    (next: Scope) => {
      setScope(next);
      const q = query;
      if (q.trim() || next === "decided") void runSearch(q, { scope: next });
    },
    [query, runSearch]
  );

  const clearType = useCallback(() => {
    setTypeFilter(null);
    router.replace("/search");
    if (lastSearched.current) void runSearch(query, { type: null });
  }, [router, runSearch, query]);

  const hasResults =
    !!result &&
    (result.exact.length > 0 || !!result.best || result.groups.some((g) => g.items.length));
  const totalShown = result
    ? result.exact.length + (result.best ? 1 : 0) + result.groups.reduce((s, g) => s + g.items.length, 0)
    : 0;
  // Year headers suppressed only when ALL results share one year (§7.2).
  const suppressYears = !!result && result.groups.length <= 1;
  const dateHint =
    !!result && hasResults && RELATIVE_DATE_TOKENS.test(query) && result.groups.length > 1;

  const pendingNote = useMemo(() => {
    if (!result) return null;
    const { myPendingReceipts, myPendingClaims, rebuildPending } = result.indexed;
    const notes: string[] = [];
    if (myPendingReceipts > 0) notes.push(t("pendingReceipts", { count: myPendingReceipts }));
    if (myPendingClaims > 0) notes.push(t("pendingClaims", { count: myPendingClaims }));
    if (!notes.length && rebuildPending) notes.push(t("pendingRebuild", { count: rebuildPending }));
    return notes.length ? notes.join(" ") : null;
  }, [result, t]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            ref={inputRef}
            data-testid="search-input"
            className="input w-full pr-9"
            placeholder={t("placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={300}
            enterKeyHint="search"
          />
          {searching && (
            <span
              className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-stone-300 border-t-indigo-600"
              aria-hidden
            />
          )}
        </div>
        <button
          data-testid="search-submit"
          className="btn-primary min-h-11 shrink-0 px-5"
          onClick={onSubmit}
          disabled={searching || (!query.trim() && scope !== "decided")}
        >
          {searching ? t("searching") : t("searchButton")}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {typeFilter && (
          <button
            data-testid="search-type-chip"
            className="pressable inline-flex items-center gap-1 rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold text-indigo-800"
            onClick={clearType}
            title={t("typeChipRemove")}
          >
            {typeFilter === "receipt" ? t("typeChipReceipts") : t("typeChipClaims")}
            <span aria-hidden>✕</span>
          </button>
        )}
        {canAll && (
          <div
            data-testid="search-scope-filter"
            role="radiogroup"
            aria-label={t("scopeLabel")}
            className="inline-flex overflow-hidden rounded-full border border-stone-300 text-xs font-semibold"
          >
            {/* "Claims I decided" only when the Approvals duty is active (§6.3). */}
            {(["mine", "all", "decided"] as const)
              .filter((s) => s !== "decided" || canDecided)
              .map((s) => (
              <button
                key={s}
                role="radio"
                aria-checked={scope === s}
                className={`px-3 py-1.5 ${scope === s ? "bg-indigo-600 text-white" : "bg-white text-stone-600 hover:bg-stone-50"}`}
                onClick={() => changeScope(s)}
              >
                {s === "mine" ? t("scopeMine") : s === "all" ? t("scopeAll") : t("scopeDecided")}
              </button>
            ))}
          </div>
        )}
        {scope === "decided" && (
          <span className="text-xs text-stone-500">{t("scopeDecidedHint")}</span>
        )}
      </div>

      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
      {slow && <p className="text-sm text-stone-500">{t("stillSearching")}</p>}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {result?.degraded && (
        <div
          data-testid="search-degraded-note"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
        >
          {t("degraded")}
        </div>
      )}

      {!result && !searching && (
        <EmptyQueryState
          t={t}
          canDecided={canDecided}
          recents={recents}
          onRun={(q, opts) => {
            setQuery(q);
            if (opts?.scope) setScope(opts.scope);
            void runSearch(q, opts);
          }}
          onClearRecents={() => {
            setRecents([]);
            try {
              localStorage.removeItem(recentsKey);
            } catch {}
          }}
        />
      )}

      <div className={searching && result ? "pointer-events-none opacity-50" : ""}>
        {result && !hasResults && !searching && (
          <div data-testid="search-empty" className="card p-8 text-center text-stone-500">
            <div className="text-3xl">🔍</div>
            <p className="mt-2 font-medium">
              {pendingNote && totalShown === 0 && (result.indexed.myPendingReceipts > 0 || result.indexed.myPendingClaims > 0)
                ? t("emptyPendingTitle")
                : t("emptyTitle")}
            </p>
            <p className="text-sm">{pendingNote ?? t("emptyBody")}</p>
          </div>
        )}

        {result && hasResults && (
          <div className="space-y-4">
            {pendingNote && (
              <p data-testid="search-pending-note" className="text-xs text-stone-500">
                {pendingNote}
              </p>
            )}
            {dateHint && (
              <p data-testid="search-date-hint" className="text-xs text-stone-500">
                {t("dateHint")}
              </p>
            )}

            {result.exact.length > 0 && (
              <section data-testid="search-exact-section">
                <SectionHeader label={t("exactMatches")} />
                <ul className="space-y-2">
                  {(showAllExact ? result.exact : result.exact.slice(0, 3)).map((item) => (
                    <ResultCard key={`${item.kind}:${item.id}`} item={item} viewer={{ userId, isRoleHolder: canAll }} scope={scope} t={t} tStatus={tStatus} format={format} />
                  ))}
                </ul>
                {result.exact.length > 3 && !showAllExact && (
                  <button
                    data-testid="search-exact-show-all"
                    className="mt-2 text-sm font-medium text-indigo-600 hover:underline"
                    onClick={() => {
                      setShowAllExact(true);
                      persistSession({ showAllExact: true });
                    }}
                  >
                    {t("showAllExact", { count: result.exact.length })}
                  </button>
                )}
              </section>
            )}

            {result.best && (
              <section data-testid="search-best-match">
                <SectionHeader label={t("bestMatch")} />
                <ul>
                  <ResultCard item={result.best} viewer={{ userId, isRoleHolder: canAll }} scope={scope} t={t} tStatus={tStatus} format={format} />
                </ul>
              </section>
            )}

            {result.groups.map((group) => (
              <section key={group.year} data-testid={`search-group-${group.year}`}>
                {!suppressYears && (
                  <div className="sticky top-14 z-10 -mx-1 bg-stone-50/95 px-1 py-1 backdrop-blur">
                    <SectionHeader label={String(group.year)} />
                  </div>
                )}
                <ul className="space-y-2">
                  {group.items.map((item) => (
                    <ResultCard key={`${item.kind}:${item.id}`} item={item} viewer={{ userId, isRoleHolder: canAll }} scope={scope} t={t} tStatus={tStatus} format={format} />
                  ))}
                </ul>
              </section>
            ))}

            {result.nextCursor && (
              <button
                data-testid="search-show-more"
                className="btn-secondary w-full"
                onClick={() => void runSearch(query, { cursor: result.nextCursor, append: true })}
              >
                {t("showMore")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function mergeGroups(
  a: { year: number; items: Item[] }[],
  b: { year: number; items: Item[] }[]
): { year: number; items: Item[] }[] {
  const map = new Map(a.map((g) => [g.year, [...g.items]]));
  for (const g of b) {
    const list = map.get(g.year) ?? [];
    map.set(g.year, [...list, ...g.items]);
  }
  return [...map.entries()].sort((x, y) => y[0] - x[0]).map(([year, items]) => ({ year, items }));
}

function SectionHeader({ label }: { label: string }) {
  return (
    <h2 className="mb-2 border-b border-stone-200 pb-1 text-xs font-bold uppercase tracking-wide text-stone-500">
      {label}
    </h2>
  );
}

function EmptyQueryState({
  t,
  canDecided,
  recents,
  onRun,
  onClearRecents,
}: {
  t: ReturnType<typeof useTranslations<"Search">>;
  canDecided: boolean;
  recents: string[];
  onRun: (q: string, opts?: { scope?: Scope }) => void;
  onClearRecents: () => void;
}) {
  const examples = [t("example1"), t("example2"), t("example3")];
  return (
    <div className="card space-y-4 p-6">
      <p className="text-sm text-stone-600">{t("teachLine")}</p>
      <div className="flex flex-wrap gap-2">
        {examples.map((ex, i) => (
          <button
            key={i}
            data-testid={`search-example-${i + 1}`}
            className="pressable rounded-full border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50"
            onClick={() => onRun(ex)}
          >
            {ex}
          </button>
        ))}
        {canDecided && (
          <button
            data-testid="search-example-4"
            className="pressable rounded-full border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50"
            onClick={() => onRun("", { scope: "decided" })}
          >
            {t("exampleDecided")}
          </button>
        )}
      </div>
      {recents.length > 0 && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-stone-400">
              {t("recentSearches")}
            </span>
            <button
              data-testid="search-recent-clear"
              className="text-xs text-stone-400 hover:text-stone-600 hover:underline"
              onClick={onClearRecents}
            >
              {t("recentClear")}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {recents.map((q, i) => (
              <button
                key={i}
                data-testid={`search-recent-${i + 1}`}
                className="pressable rounded-full bg-stone-100 px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-200"
                onClick={() => onRun(q)}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Whole-card link target per §7.3's viewer × state table. Null = the card is
 *  informational (no pressable affordance, so it doesn't read as broken). */
function claimHref(
  claim: ClaimItem,
  viewer: { userId: string; isRoleHolder: boolean }
): string | null {
  if (claim.ownerId === viewer.userId) return `/claims/${claim.id}`;
  if (claim.approverUserId === viewer.userId && claim.status !== "draft" && claim.status !== "generated") {
    return `/approvals?open=${claim.id}`;
  }
  if (viewer.isRoleHolder && (claim.status === "approved" || claim.status === "paid")) {
    return `/finance?open=${claim.id}`;
  }
  return null;
}

function ResultCard({
  item,
  viewer,
  scope,
  t,
  tStatus,
  format,
}: {
  item: Item;
  viewer: { userId: string; isRoleHolder: boolean };
  scope: Scope;
  t: ReturnType<typeof useTranslations<"Search">>;
  tStatus: ReturnType<typeof useTranslations<"Common.status">>;
  format: ReturnType<typeof useFormatter>;
}) {
  if (item.kind === "receipt") {
    const single = item.claims.length === 1 ? item.claims[0] : null;
    // §7.3: own receipt on one claim → that claim; foreign or ambiguous →
    // the receipt itself (viewer), chips stay informational.
    const singleHref =
      single && item.ownerId === viewer.userId ? `/claims/${single.id}` : null;
    const href =
      item.claims.length === 0
        ? `/?open=${item.id}`
        : (singleHref ?? `/api/receipts/${item.id}/file`);
    const external = item.claims.length > 0 && !singleHref;
    const dateLabel = /^\d{4}-\d{2}-\d{2}/.test(item.purchaseDate)
      ? format.dateTime(new Date(item.purchaseDate + "T00:00:00"), {
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : null;
    const body = (
      <>
        <img
          src={
            item.mimeType === "application/pdf"
              ? `/api/receipts/${item.id}/preview?page=1`
              : `/api/receipts/${item.id}/file`
          }
          alt=""
          className="h-16 w-16 shrink-0 rounded-lg object-cover"
          loading="lazy"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">
            {item.merchant || t("receiptFallbackTitle")}
            {dateLabel && <span className="ml-2 font-normal text-stone-500">{dateLabel}</span>}
          </div>
          {item.note && <div className="truncate text-sm text-stone-500">{item.note}</div>}
          {item.ownerName && scope !== "mine" && (
            <div className="truncate text-xs text-stone-400">{item.ownerName}</div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {item.claims.length === 0 ? (
              <>
                <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
                  {t("notOnClaim")}
                </span>
                <span
                  data-testid={`search-find-in-receipts-${item.id}`}
                  className="text-xs font-medium text-indigo-600"
                >
                  {t("findInReceipts")}
                </span>
              </>
            ) : (
              item.claims.map((c) => (
                <span
                  key={c.id}
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLES[c.status] ?? "bg-stone-100 text-stone-600"}`}
                >
                  {t("onClaim", { status: tStatus(statusKey(c.status) as never) })}
                </span>
              ))
            )}
          </div>
        </div>
      </>
    );
    return (
      <li data-testid={`search-result-receipt-${item.id}`}>
        {external ? (
          <a href={href} target="_blank" rel="noreferrer" className="card card-lift pressable flex items-start gap-3 p-3">
            {body}
          </a>
        ) : (
          <Link href={href} className="card card-lift pressable flex items-start gap-3 p-3">
            {body}
          </Link>
        )}
      </li>
    );
  }

  const href = claimHref(item, viewer);
  const inner = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLES[item.status] ?? "bg-stone-100 text-stone-600"}`}
          >
            {tStatus(statusKey(item.status) as never)}
          </span>
          <span className="font-semibold">{formatCents(item.totalCents)}</span>
          <span className="text-xs text-stone-400">
            {format.dateTime(new Date(item.createdAt), { year: "numeric", month: "long", day: "numeric" })}
          </span>
        </div>
        {item.claimDescription && (
          <div className="mt-1 truncate text-sm text-stone-600">{item.claimDescription}</div>
        )}
        {item.ownerName && scope !== "mine" && (
          <div className="truncate text-xs text-stone-400">{item.ownerName}</div>
        )}
        {item.ministries.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {item.ministries.map((m) => (
              <span key={m} className="truncate rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-500">
                {m}
              </span>
            ))}
          </div>
        )}
      </div>
      <span aria-hidden className="text-2xl">
        📄
      </span>
    </div>
  );
  return (
    <li data-testid={`search-result-claim-${item.id}`}>
      {href ? (
        <Link href={href} className="card card-lift pressable block p-3">
          {inner}
        </Link>
      ) : (
        <div className="card block p-3">{inner}</div>
      )}
    </li>
  );
}

