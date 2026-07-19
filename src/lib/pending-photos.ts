"use client";

/**
 * Crash safety for the Shoebox prepare queue. Picked photos live only in
 * component state until their prepare dialog is dismissed — and iOS never
 * fires `beforeunload` (WebKit policy) and reclaims background tabs freely,
 * so a phone user who switches apps mid-queue could silently lose photos.
 * Each picked photo is stashed here (IndexedDB survives the tab) and removed
 * once its upload succeeds; leftovers are re-queued on the next visit.
 *
 * Best-effort only: every call swallows failures (private mode, quota) —
 * the queue still works exactly as before, just without the safety net.
 */

const DB_NAME = "numbers-shoebox";
const STORE = "pending-photos";

export interface StoredPendingPhoto {
  id: string;
  file: File;
  addedAt: number;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    } catch {
      db.close();
      resolve(null);
    }
  });
}

export async function stashPendingPhoto(id: string, file: File): Promise<void> {
  await withStore("readwrite", (s) =>
    s.put({ id, file, addedAt: Date.now() } satisfies StoredPendingPhoto)
  );
}

export async function removePendingPhoto(id: string): Promise<void> {
  await withStore("readwrite", (s) => s.delete(id));
}

export async function loadPendingPhotos(): Promise<StoredPendingPhoto[]> {
  const rows = (await withStore("readonly", (s) => s.getAll())) as StoredPendingPhoto[] | null;
  // Oldest first so the restored queue keeps its original order; drop
  // malformed rows defensively (a File that didn't survive the clone).
  return (rows ?? [])
    .filter((r) => r && typeof r.id === "string" && r.file instanceof File)
    .sort((a, b) => a.addedAt - b.addedAt);
}
