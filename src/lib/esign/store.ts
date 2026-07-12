/**
 * Ledger event stores (docs/ESIGN_DESIGN.md §3 "ledger-io"). Client-safe.
 * The store is transport only: envelopes are sealed/opened by envelope.ts,
 * and everything above the wire treats events as opaque ciphertext docs.
 *
 * - mock: the ESIGN_MOCK SQLite-backed API routes (dev/tests).
 * - firestore: raw `polls/{id}/events` docs via the Firebase client SDK,
 *   loaded lazily so the SDK stays out of non-e-sign bundles.
 */

import type { RawLedgerEventDoc } from "./types";

export type EsignBackend = "mock" | "firestore";

export interface LedgerStore {
  /** Append one event; event ids are create-once. A 409/already-exists on a
   *  ceremony retry is success (the id derives from the action hash). */
  append(ledgerId: string, doc: Omit<RawLedgerEventDoc, "createdAtMs">): Promise<void>;
  list(ledgerId: string): Promise<RawLedgerEventDoc[]>;
  /** Live-watch the ledger's events. `onChange` fires whenever the event set
   *  changes AFTER the state at subscription time — never for that initial
   *  snapshot, so the caller keeps its own current view. Returns the
   *  unsubscribe. Firestore uses onSnapshot; the mock backend polls. */
  subscribe(ledgerId: string, onChange: () => void): () => void;
}

/** Mock-backend poll cadence for `subscribe`. Roster changes (a vouch, a role
 *  grant) are human-paced, so this stays gentler than device-sync's 1.2s. */
const MOCK_POLL_MS = 2000;

class MockHttpStore implements LedgerStore {
  async append(ledgerId: string, doc: Omit<RawLedgerEventDoc, "createdAtMs">): Promise<void> {
    const res = await fetch(`/api/esign-mock/${encodeURIComponent(ledgerId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    if (!res.ok && res.status !== 409) {
      throw new Error((await res.json().catch(() => null))?.error ?? `Append failed (${res.status})`);
    }
  }

  async list(ledgerId: string): Promise<RawLedgerEventDoc[]> {
    const res = await fetch(`/api/esign-mock/${encodeURIComponent(ledgerId)}`);
    if (!res.ok) {
      throw new Error((await res.json().catch(() => null))?.error ?? `List failed (${res.status})`);
    }
    return (await res.json()).events as RawLedgerEventDoc[];
  }

  subscribe(ledgerId: string, onChange: () => void): () => void {
    let stopped = false;
    // Baseline of event ids from the first successful poll; null until then so
    // the first tick establishes it without firing (the caller already has it).
    let seen: string | null = null;
    const tick = async () => {
      try {
        const res = await fetch(`/api/esign-mock/${encodeURIComponent(ledgerId)}`);
        if (stopped || !res.ok) return;
        const events = ((await res.json()).events ?? []) as RawLedgerEventDoc[];
        if (stopped) return;
        const key = events.map((e) => e.eventId).join(",");
        if (seen === null) seen = key;
        else if (key !== seen) {
          seen = key;
          onChange();
        }
      } catch {
        // A transient poll failure is non-fatal: a later tick (or a manual
        // reload) recovers, so keep the interval alive.
      }
    };
    void tick();
    const interval = setInterval(() => void tick(), MOCK_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }
}

export function getLedgerStore(backend: EsignBackend): LedgerStore {
  if (backend === "mock") return new MockHttpStore();
  return new LazyFirestoreStore();
}

/** Defers the firebase import until a ledger call actually happens. */
class LazyFirestoreStore implements LedgerStore {
  private real: Promise<LedgerStore> | null = null;
  private resolve(): Promise<LedgerStore> {
    this.real ??= import("./store-firestore").then((m) => new m.FirestoreLedgerStore());
    return this.real;
  }
  async append(ledgerId: string, doc: Omit<RawLedgerEventDoc, "createdAtMs">): Promise<void> {
    return (await this.resolve()).append(ledgerId, doc);
  }
  async list(ledgerId: string): Promise<RawLedgerEventDoc[]> {
    return (await this.resolve()).list(ledgerId);
  }
  subscribe(ledgerId: string, onChange: () => void): () => void {
    // The SDK import is async, but callers need a synchronous unsubscribe:
    // hand back a teardown that cancels whichever listener eventually attaches.
    let inner: (() => void) | null = null;
    let stopped = false;
    void this.resolve().then((store) => {
      if (stopped) return;
      inner = store.subscribe(ledgerId, onChange);
    });
    return () => {
      stopped = true;
      inner?.();
    };
  }
}
