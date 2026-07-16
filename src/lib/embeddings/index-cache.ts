import { prisma } from "@/lib/prisma";
import type { EmbeddingKind } from "./types";

/**
 * In-memory scoring engine (docs/SEARCH_DESIGN.md §6.4): all current-model
 * vectors as Float32Arrays + parallel metadata. Two rules keep it cheap while
 * a 4-hour backfill finalizes a job every ~15 s:
 *  - DELTA application: the worker upserts/removes its own row in-process;
 *    the version counter forces a full reload only on delete/reset/rebuild.
 *  - SINGLE-FLIGHT: concurrent searches share one in-flight reload promise.
 */

export type IndexEntry = {
  kind: EmbeddingKind;
  targetId: string;
  userId: string;
  year: number;
  vector: Float32Array;
};

type CacheState = {
  version: number; // bumped externally to force a reload
  loadedVersion: number;
  loadedModel: string;
  entries: Map<string, IndexEntry>; // key = kind:targetId
  loading: Promise<void> | null;
};

const g = globalThis as unknown as { __embedIndex?: CacheState };
function state(): CacheState {
  if (!g.__embedIndex) {
    g.__embedIndex = {
      version: 1,
      loadedVersion: 0,
      loadedModel: "",
      entries: new Map(),
      loading: null,
    };
  }
  return g.__embedIndex;
}

const key = (kind: string, targetId: string) => `${kind}:${targetId}`;

/** Force a full reload on next search (delete/reset/rebuild paths). */
export function invalidateIndexCache(): void {
  state().version++;
}

/** Worker delta after finalize — no reload, no version bump. */
export function indexCacheUpsert(entry: IndexEntry, model: string): void {
  const s = state();
  if (s.loadedVersion !== s.version || s.loadedModel !== model) return; // not loaded → next load picks it up
  s.entries.set(key(entry.kind, entry.targetId), entry);
}

export function indexCacheRemove(kind: EmbeddingKind, targetId: string): void {
  const s = state();
  s.entries.delete(key(kind, targetId));
}

async function reload(model: string): Promise<void> {
  const s = state();
  const targetVersion = s.version;
  const rows = await prisma.embedding.findMany({
    where: { model },
    select: { kind: true, targetId: true, userId: true, year: true, vector: true },
  });
  const entries = new Map<string, IndexEntry>();
  for (const r of rows) {
    const buf = Buffer.from(r.vector);
    entries.set(key(r.kind, r.targetId), {
      kind: r.kind as EmbeddingKind,
      targetId: r.targetId,
      userId: r.userId,
      year: r.year,
      vector: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
    });
  }
  s.entries = entries;
  s.loadedVersion = targetVersion;
  s.loadedModel = model;
}

/** All entries for the current model, reloading (single-flight) if stale. */
export async function indexEntries(model: string): Promise<IndexEntry[]> {
  const s = state();
  if (s.loadedVersion !== s.version || s.loadedModel !== model) {
    if (!s.loading) {
      s.loading = reload(model).finally(() => {
        s.loading = null;
      });
    }
    await s.loading;
    // A concurrent invalidation can land mid-reload; one more pass settles it.
    if (s.loadedVersion !== s.version || s.loadedModel !== model) {
      return indexEntries(model);
    }
  }
  return [...s.entries.values()];
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
