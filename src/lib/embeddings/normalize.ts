/**
 * Query normalization for the exact-match pass (docs/SEARCH_DESIGN.md §6.2).
 * Dependency-free and pure — unit-tested directly.
 */

/** NFKC (full-width IME digits/punctuation → half-width) + lowercase + trim. */
export function normalizeQuery(q: string): string {
  return q.normalize("NFKC").toLowerCase().trim();
}

/** Whitespace-split terms; every term must match (AND). */
export function queryTerms(q: string): string[] {
  return normalizeQuery(q).split(/\s+/).filter(Boolean);
}

/** Escape LIKE wildcards for a `LIKE ? ESCAPE '\'` pattern fragment. */
export function escapeLike(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Money detection incl. Chinese input habits: strips $ ¥ ￥ 元 and commas
 * after NFKC (２１４．８０ → 214.80), returns integer cents or null.
 * Mirrors parseDollarsToCents' accept set without throwing.
 */
export function parseQueryMoneyCents(term: string): number | null {
  const cleaned = normalizeQuery(term)
    .replace(/[$¥￥,]/g, "")
    .replace(/元$/, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith("-");
  const [d, c = ""] = cleaned.replace("-", "").split(".");
  const cents = Number(d) * 100 + Number((c + "00").slice(0, 2));
  return negative ? -cents : cents;
}
