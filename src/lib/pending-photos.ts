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

// Photos are stored as raw bytes + metadata, NOT as the File itself: WebKit
// rejects Blob/File values in IndexedDB puts ("Error preparing Blob/File
// data") — precisely the engine this safety net exists for. ArrayBuffers
// store everywhere; the File is rebuilt on load.
interface StoredRow {
  id: string;
  name: string;
  type: string;
  lastModified: number;
  data: ArrayBuffer;
  addedAt: number;
  /** Legacy shape (pre-bytes rows written by engines that allowed it). */
  file?: File;
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
  let data: ArrayBuffer;
  try {
    data = await file.arrayBuffer();
  } catch {
    return; // best-effort: an unreadable pick just skips the safety net
  }
  await withStore("readwrite", (s) =>
    s.put({
      id,
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      data,
      addedAt: Date.now(),
    } satisfies StoredRow)
  );
}

export async function removePendingPhoto(id: string): Promise<void> {
  await withStore("readwrite", (s) => s.delete(id));
}

export async function loadPendingPhotos(): Promise<StoredPendingPhoto[]> {
  const rows = (await withStore("readonly", (s) => s.getAll())) as StoredRow[] | null;
  // Oldest first so the restored queue keeps its original order; drop
  // malformed rows defensively (bytes that didn't survive the clone).
  return (rows ?? [])
    .filter((r): r is StoredRow => !!r && typeof r.id === "string")
    .map((r) => {
      if (r.file instanceof File) return { id: r.id, file: r.file, addedAt: r.addedAt }; // legacy row
      if (!(r.data instanceof ArrayBuffer)) return null;
      return {
        id: r.id,
        file: new File([r.data], r.name || "photo.jpg", {
          type: r.type || "image/jpeg",
          lastModified: r.lastModified || r.addedAt,
        }),
        addedAt: r.addedAt,
      };
    })
    .filter((r): r is StoredPendingPhoto => r !== null)
    .sort((a, b) => a.addedAt - b.addedAt);
}
