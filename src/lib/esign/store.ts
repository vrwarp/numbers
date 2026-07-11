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
}

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
}
