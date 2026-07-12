"use client";

/**
 * Real ledger backend: raw `polls/{ledgerId}/events/{eventId}` documents via
 * the Firebase client SDK (docs/ESIGN_DESIGN.md §3). Bypasses charproof's
 * LedgerSession on purpose — sessions strip createdAt/event ids, silently
 * drop invalid events, and mint junk keypairs for read-only visitors. The
 * document shape (and the write's serverTimestamp) matches both charproof's
 * own store and the forked firestore.rules exactly.
 */

import { ensureFirebaseAuth, getDb } from "./firebase-client";
import type { LedgerStore } from "./store";
import type { RawLedgerEventDoc } from "./types";

export class FirestoreLedgerStore implements LedgerStore {
  async append(ledgerId: string, docIn: Omit<RawLedgerEventDoc, "createdAtMs">): Promise<void> {
    await ensureFirebaseAuth();
    const [db, fs] = [await getDb(), await import("firebase/firestore")];
    // Ledger pointer doc (create-once; ignore failures when it exists).
    await fs
      .setDoc(fs.doc(db, "polls", ledgerId), { pollId: ledgerId, createdAt: fs.serverTimestamp() })
      .catch(() => {});
    try {
      await fs.setDoc(fs.doc(db, "polls", ledgerId, "events", docIn.eventId), {
        eventId: docIn.eventId,
        createdAt: fs.serverTimestamp(),
        encryptedData: docIn.encryptedData,
        iv: docIn.iv,
      });
    } catch (err) {
      // The rules deny create-on-existing (update) — a retry of the same
      // derived event id is success, anything else is real.
      const code = (err as { code?: string })?.code ?? "";
      if (code !== "permission-denied" && code !== "already-exists") throw err;
    }
  }

  async list(ledgerId: string): Promise<RawLedgerEventDoc[]> {
    await ensureFirebaseAuth();
    const [db, fs] = [await getDb(), await import("firebase/firestore")];
    const snap = await fs.getDocs(
      fs.query(fs.collection(db, "polls", ledgerId, "events"), fs.orderBy("createdAt", "asc"))
    );
    return snap.docs.map((d) => {
      const data = d.data() as {
        createdAt?: { toMillis(): number };
        encryptedData: string;
        iv: string;
      };
      return {
        eventId: d.id,
        // toMillis() carries Firestore's nanosecond precision as FRACTIONAL
        // millis; the protocol's ordering value is integer ms everywhere
        // (the mirror stores it as a BigInt).
        createdAtMs: Math.round(data.createdAt?.toMillis() ?? 0),
        encryptedData: data.encryptedData,
        iv: data.iv,
      };
    });
  }

  subscribe(ledgerId: string, onChange: () => void): () => void {
    // Attach is async (auth + SDK import), but callers need a synchronous
    // unsubscribe — hand back a teardown that cancels the listener once (and if)
    // it lands.
    let inner: (() => void) | null = null;
    let stopped = false;
    void (async () => {
      await ensureFirebaseAuth();
      if (stopped) return;
      const [db, fs] = [await getDb(), await import("firebase/firestore")];
      if (stopped) return;
      let first = true;
      inner = fs.onSnapshot(
        fs.query(fs.collection(db, "polls", ledgerId, "events"), fs.orderBy("createdAt", "asc")),
        { includeMetadataChanges: false },
        (snap) => {
          // The initial snapshot is the state the caller already holds; only
          // react to CHANGES after it. Skip snapshots reflecting only our own
          // not-yet-acknowledged writes so we react once, on server confirmation.
          if (first) {
            first = false;
            return;
          }
          if (snap.metadata.hasPendingWrites) return;
          onChange();
        },
        () => {
          // A dropped listener (permissions, transport reset) leaves the manual
          // reload path intact — don't surface it as a hard failure here.
        }
      );
    })();
    return () => {
      stopped = true;
      inner?.();
    };
  }
}
