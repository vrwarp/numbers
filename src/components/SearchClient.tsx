"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useDateLabel } from "@/lib/use-date-label";
import { formatCents } from "@/lib/money";
import { useApiErrorMessage } from "@/lib/use-api-error";

/**
 * The /search screen (docs/SEARCH_DESIGN.md §7): explicit-submit search with
 * an IME-safe Enter guard, an exact-match strip (≤3 + show all), a Best-match
 * pin only when no exact hits, year-grouped semantic results, per-kind pending
 * notes, degraded mode, cross-device recents (server-backed, 90-day window,
 * clearable), and URL-encoded state (q/scope/type) so refresh and Back restore
 * the view without retyping.
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

type Scope = "mine" | "all" | "decided" | "team";
type TypeFilter = "receipt" | "claim" | null;

/** Scopes that browse their set on an empty query ("list everything"):
 *  decided claims, and the team read grant's receipts (§6.3). */
const browsesEmpty = (s: Scope) => s === "decided" || s === "team";

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
  canTeam,
}: {
  userId: string;
  // Cross-tenant search capabilities (docs/SEARCH_DESIGN.md §6.3): the verified
  // role narrowed by the A10 duty pauses. canAll → whole-church scope; canDecided
  // → the "Claims I decided" browse (implies canAll). canTeam is different in
  // kind: membership-derived (active Team with budget categories), so a plain
  // member can hold it without any role.
  canAll: boolean;
  canDecided: boolean;
  canTeam: boolean;
}) {
  const t = useTranslations("Search");
  const tStatus = useTranslations("Common.status");
  const formatDate = useDateLabel();
  const params = useSearchParams();
  const errorMessage = useApiErrorMessage();

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("mine");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllExact, setShowAllExact] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  // Recent searches live in a dropdown under the input (their natural home).
  // The Show/Where filter row sits above the input so the dropdown never
  // overlaps it; open on focus, but only with an empty query so typing/
  // composition and result-viewing are never covered. activeRecent is the
  // keyboard-highlighted row (-1 = none).
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [activeRecent, setActiveRecent] = useState(-1);
  const [announce, setAnnounce] = useState("");
  const submitSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The URL is the single source of restore state (§7.4): ?q / ?scope / ?type
  // encode the view so a refresh or Back reproduces it without retyping — IME
  // users pay the composition tax only once. Written with replaceState so it
  // never triggers a soft navigation / server round-trip.
  const syncUrl = useCallback((q: string, sc: Scope, ty: TypeFilter) => {
    const sp = new URLSearchParams();
    if (q.trim()) sp.set("q", q.trim());
    if (sc !== "mine") sp.set("scope", sc);
    if (ty) sp.set("type", ty);
    const qs = sp.toString();
    window.history.replaceState(null, "", qs ? `/search?${qs}` : "/search");
  }, []);

  // Rehydrate from the URL on mount, then auto-run if there's anything to show.
  useEffect(() => {
    const urlQ = params.get("q") ?? "";
    const urlType = params.get("type");
    const urlScope = params.get("scope");
    let initScope: Scope = "mine";
    if (urlScope === "all" && canAll) initScope = "all";
    else if (urlScope === "decided" && canDecided) initScope = "decided";
    else if (urlScope === "team" && canTeam) initScope = "team";
    const initType: TypeFilter =
      urlType === "receipt" || urlType === "claim" ? urlType : null;
    setQuery(urlQ);
    setScope(initScope);
    setTypeFilter(initType);
    inputRef.current?.focus();
    // Recents live server-side now (cross-device); seed from the user's history.
    // Merge rather than replace: a query auto-run from ?q= on this same mount
    // records itself optimistically, and must not be clobbered if the history
    // GET resolves after it.
    fetch("/api/search/history")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!Array.isArray(d?.recents)) return;
        setRecents((prev) => [...prev, ...d.recents.filter((q: string) => !prev.includes(q))].slice(0, 5));
      })
      .catch(() => {});
    if (urlQ.trim() || browsesEmpty(initScope)) {
      void runSearch(urlQ, { scope: initScope, type: initType });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The server records the query (POST /api/search) and owns the durable
  // history; this only mirrors it optimistically into the open dropdown.
  const rememberRecent = useCallback((q: string) => {
    if (!q.trim()) return;
    setRecents((prev) => [q, ...prev.filter((x) => x !== q)].slice(0, 5));
  }, []);

  const clearRecents = useCallback(() => {
    setRecents([]);
    setRecentsOpen(false);
    setActiveRecent(-1);
    void fetch("/api/search/history", { method: "DELETE" }).catch(() => {});
  }, []);

  const runSearch = useCallback(
    async (
      q: string,
      opts: { scope?: Scope; type?: TypeFilter; cursor?: string; append?: boolean } = {}
    ) => {
      const useScope = opts.scope ?? scope;
      const useType = opts.type !== undefined ? opts.type : typeFilter;
      if (!q.trim() && !browsesEmpty(useScope)) return;
      if (!opts.append && !opts.cursor) syncUrl(q, useScope, useType);
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
        const merged = opts.append && result
          ? { ...data, groups: mergeGroups(result.groups, data.groups) }
          : data;
        setResult(merged);
        setShowAllExact(false);
        rememberRecent(q);
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
    [scope, typeFilter, result, t, errorMessage, rememberRecent, syncUrl]
  );

  const onSubmit = useCallback(() => void runSearch(query), [runSearch, query]);

  const recentsVisible = recentsOpen && !query.trim() && recents.length > 0;

  const pickRecent = useCallback(
    (q: string) => {
      setQuery(q);
      setRecentsOpen(false);
      setActiveRecent(-1);
      void runSearch(q);
    },
    [runSearch]
  );

  // IME safety (§7.4): Enter while composing commits the composition buffer,
  // never fires a search — pinyin users typing 王姐妹 must not search "wang".
  // The recents dropdown adds a combobox layer on top: arrows move the
  // highlight, Enter on a highlighted row runs it, Escape closes.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (recentsVisible && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        setActiveRecent((i) =>
          e.key === "ArrowDown" ? Math.min(recents.length - 1, i + 1) : Math.max(-1, i - 1)
        );
        return;
      }
      if (e.key === "Escape" && recentsVisible) {
        setRecentsOpen(false);
        setActiveRecent(-1);
        return;
      }
      if (e.key !== "Enter") return;
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (recentsVisible && activeRecent >= 0) {
        e.preventDefault();
        pickRecent(recents[activeRecent]);
        return;
      }
      onSubmit();
    },
    [recentsVisible, recents, activeRecent, onSubmit, pickRecent]
  );

  const changeScope = useCallback(
    (next: Scope) => {
      setScope(next);
      const q = query;
      if (q.trim() || browsesEmpty(next)) void runSearch(q, { scope: next });
      else syncUrl(q, next, typeFilter);
    },
    [query, runSearch, syncUrl, typeFilter]
  );

  // Three-way type filter (Both / Receipts / Claims), always available — unlike
  // the old removable chip it can be turned back on after clearing.
  const changeType = useCallback(
    (next: TypeFilter) => {
      setTypeFilter(next);
      if (query.trim() || browsesEmpty(scope)) void runSearch(query, { type: next });
      else syncUrl(query, scope, next);
    },
    [query, scope, runSearch, syncUrl]
  );

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

      <div className="flex flex-wrap items-center gap-2">
        {/* "Show" — the type filter is available to everyone (not role-gated).
            Label + control stay in one non-wrapping group so the label never
            strands on a line above its buttons. */}
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="text-xs font-semibold uppercase tracking-wide text-stone-400"
          >
            {t("typeFilterLabel")}
          </span>
          <div
            data-testid="search-type-filter"
            role="radiogroup"
            aria-label={t("typeFilterLabel")}
            className="inline-flex overflow-hidden rounded-full border border-stone-300 text-xs font-semibold"
          >
            {([null, "receipt", "claim"] as const).map((ty) => (
              <button
                key={ty ?? "all"}
                role="radio"
                aria-checked={typeFilter === ty}
                className={`px-3 py-1.5 ${typeFilter === ty ? "bg-indigo-600 text-white" : "bg-white text-stone-600 hover:bg-stone-50"}`}
                onClick={() => changeType(ty)}
              >
                {ty === null ? t("typeAll") : ty === "receipt" ? t("typeReceipts") : t("typeClaims")}
              </button>
            ))}
          </div>
        </div>
        {(canAll || canTeam) && (
          /* "Where" — the cross-tenant scope control (§6.3): role-holders,
              plus team members (membership-derived, §6.3 team amendment).
              Label + control share one non-wrapping group so "Where" wraps
              onto the second line together with its buttons. */
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="text-xs font-semibold uppercase tracking-wide text-stone-400"
            >
              {t("scopeFilterLabel")}
            </span>
            <div
              data-testid="search-scope-filter"
              role="radiogroup"
              aria-label={t("scopeLabel")}
              className="inline-flex overflow-hidden rounded-full border border-stone-300 text-xs font-semibold"
            >
              {/* Each cross-tenant segment appears only with its grant: "Whole
                  church" (canAll), "My teams" (canTeam), "Claims I decided"
                  (canDecided, §6.3). */}
              {([
                "mine",
                ...(canAll ? (["all"] as const) : []),
                ...(canTeam ? (["team"] as const) : []),
                ...(canDecided ? (["decided"] as const) : []),
              ] as Scope[]).map((s) => (
                <button
                  key={s}
                  role="radio"
                  aria-checked={scope === s}
                  className={`px-3 py-1.5 ${scope === s ? "bg-indigo-600 text-white" : "bg-white text-stone-600 hover:bg-stone-50"}`}
                  onClick={() => changeScope(s)}
                >
                  {s === "mine"
                    ? t("scopeMine")
                    : s === "all"
                      ? t("scopeAll")
                      : s === "team"
                        ? t("scopeTeam")
                        : t("scopeDecided")}
                </button>
              ))}
            </div>
          </div>
        )}
        {scope === "decided" && (
          <span className="text-xs text-stone-500">{t("scopeDecidedHint")}</span>
        )}
        {scope === "team" && (
          <span className="text-xs text-stone-500">{t("scopeTeamHint")}</span>
        )}
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            ref={inputRef}
            data-testid="search-input"
            className="input h-11 w-full pr-9"
            placeholder={t("placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setRecentsOpen(true)}
            onBlur={() => {
              setRecentsOpen(false);
              setActiveRecent(-1);
            }}
            role="combobox"
            aria-expanded={recentsVisible}
            aria-controls="search-recents-list"
            aria-autocomplete="list"
            maxLength={300}
            enterKeyHint="search"
          />
          {searching && (
            <span
              className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-stone-300 border-t-indigo-600"
              aria-hidden
            />
          )}
          {recentsVisible && (
            <div
              data-testid="search-recents"
              className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-stone-200 bg-white py-1 shadow-lg"
            >
              <div className="flex items-center justify-between gap-2 px-3 py-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-stone-400">
                  {t("recentSearches")}
                </span>
                <button
                  type="button"
                  data-testid="search-recents-clear"
                  className="text-xs font-medium text-indigo-600 hover:underline"
                  // Keep input focus so blur doesn't close the list before the click lands.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={clearRecents}
                >
                  {t("clearRecents")}
                </button>
              </div>
              <ul
                id="search-recents-list"
                role="listbox"
                aria-label={t("recentSearches")}
              >
                {recents.map((q, i) => (
                  <li key={i} role="option" aria-selected={i === activeRecent}>
                    <button
                      type="button"
                      data-testid={`search-recent-${i + 1}`}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-stone-700 ${i === activeRecent ? "bg-stone-100" : "hover:bg-stone-50"}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickRecent(q)}
                    >
                      <span className="truncate">{q}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <button
          data-testid="search-submit"
          className="btn-primary min-h-11 shrink-0 px-5"
          onClick={onSubmit}
          disabled={searching || (!query.trim() && !browsesEmpty(scope))}
        >
          {searching ? t("searching") : t("searchButton")}
        </button>
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
                    <ResultCard key={`${item.kind}:${item.id}`} item={item} viewer={{ userId, isRoleHolder: canAll }} scope={scope} t={t} tStatus={tStatus} formatDate={formatDate} />
                  ))}
                </ul>
                {result.exact.length > 3 && !showAllExact && (
                  <button
                    data-testid="search-exact-show-all"
                    className="mt-2 text-sm font-medium text-indigo-600 hover:underline"
                    onClick={() => setShowAllExact(true)}
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
                  <ResultCard item={result.best} viewer={{ userId, isRoleHolder: canAll }} scope={scope} t={t} tStatus={tStatus} formatDate={formatDate} />
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
                    <ResultCard key={`${item.kind}:${item.id}`} item={item} viewer={{ userId, isRoleHolder: canAll }} scope={scope} t={t} tStatus={tStatus} formatDate={formatDate} />
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
  formatDate,
}: {
  item: Item;
  viewer: { userId: string; isRoleHolder: boolean };
  scope: Scope;
  t: ReturnType<typeof useTranslations<"Search">>;
  tStatus: ReturnType<typeof useTranslations<"Common.status">>;
  formatDate: ReturnType<typeof useDateLabel>;
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
    const purchaseLabel = /^\d{4}-\d{2}-\d{2}/.test(item.purchaseDate)
      ? formatDate(item.purchaseDate + "T00:00:00", {
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
            {purchaseLabel && <span className="ml-2 font-normal text-stone-500">{purchaseLabel}</span>}
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
            {formatDate(item.createdAt, { year: "numeric", month: "long", day: "numeric" })}
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

