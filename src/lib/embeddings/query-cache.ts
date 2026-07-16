/**
 * Server-side LRU for query embeddings (docs/SEARCH_DESIGN.md §6.1 step 3):
 * repeated searches, back-navigation, and filter tweaks skip the ~500 ms embed.
 * Keyed on (model, queryPrefix, normalized query); a model change implicitly
 * invalidates by key.
 */

type Entry = { vector: Float32Array; at: number };

const MAX_ENTRIES = 200;
const TTL_MS = 15 * 60_000;

const g = globalThis as unknown as { __embedQueryLru?: Map<string, Entry> };
function lru(): Map<string, Entry> {
  if (!g.__embedQueryLru) g.__embedQueryLru = new Map();
  return g.__embedQueryLru;
}

export function cachedQueryVector(key: string): Float32Array | null {
  const m = lru();
  const e = m.get(key);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) {
    m.delete(key);
    return null;
  }
  // Refresh recency.
  m.delete(key);
  m.set(key, e);
  return e.vector;
}

export function storeQueryVector(key: string, vector: Float32Array): void {
  const m = lru();
  m.set(key, { vector, at: Date.now() });
  while (m.size > MAX_ENTRIES) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}
