"use client";

/**
 * Key custody (docs/ESIGN_DESIGN.md §4). The member's church identity is
 * their roster-ledger keypair; claim ledgers reuse it (§4.1). Two backends:
 *
 * - LocalKeyCustody (ESIGN_MOCK / dev): keys in this browser's IndexedDB
 *   only — no cross-device sync, losing the browser profile means
 *   re-vouching. The signing protocol is identical to production.
 * - CharproofKeyCustody (real): AMK-encrypted keystore via charproof, which
 *   syncs identities/ledger keys across the member's enrolled devices and
 *   backs them with phrase/PRF recovery. Requires live Firebase; exercised
 *   only in real deployments.
 *
 * Both also hold the TOFU root-fingerprint pin (§4.6) locally.
 */

import { generateSigningKeyPair, type SigningKeyPair } from "./envelope";

export interface KeyCustody {
  /** The member's identity keypair (roster keypair), if enrolled here. */
  getIdentity(rosterLedgerId: string): Promise<SigningKeyPair | null>;
  /** Create-or-load the identity keypair for this roster. */
  ensureIdentity(rosterLedgerId: string, rosterLedgerKey: string): Promise<SigningKeyPair>;
  getLedgerKey(ledgerId: string): Promise<string | null>;
  saveLedgerKey(ledgerId: string, keyB64: string): Promise<void>;
  getRootPin(): Promise<string | null>;
  setRootPin(fingerprintHex: string): Promise<void>;
}

// --- Minimal IndexedDB promise wrapper ----------------------------------------

const DB_NAME = "numbers-esign";
const STORE = "kv";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvGet<T>(key: string): Promise<T | null> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Local custody -------------------------------------------------------------

export class LocalKeyCustody implements KeyCustody {
  async getIdentity(rosterLedgerId: string): Promise<SigningKeyPair | null> {
    return kvGet<SigningKeyPair>(`identity:${rosterLedgerId}`);
  }
  async ensureIdentity(rosterLedgerId: string): Promise<SigningKeyPair> {
    const existing = await this.getIdentity(rosterLedgerId);
    if (existing) return existing;
    const pair = await generateSigningKeyPair();
    await kvSet(`identity:${rosterLedgerId}`, pair);
    return pair;
  }
  async getLedgerKey(ledgerId: string): Promise<string | null> {
    return kvGet<string>(`ledgerKey:${ledgerId}`);
  }
  async saveLedgerKey(ledgerId: string, keyB64: string): Promise<void> {
    await kvSet(`ledgerKey:${ledgerId}`, keyB64);
  }
  async getRootPin(): Promise<string | null> {
    return kvGet<string>("rootPin");
  }
  async setRootPin(fingerprintHex: string): Promise<void> {
    await kvSet("rootPin", fingerprintHex);
  }
}

// --- charproof custody (real backend) -------------------------------------------

/**
 * Backs the same interface with charproof's AMK-encrypted keystore: the
 * roster identity lives in the keystore entry for the roster ledger, and
 * claim-ledger entries are pre-seeded with that SAME signing keypair (§4.1)
 * so a member signs everything with their attested key. Phase-1 spike:
 * confirm entry shape round-trips; fall back to roster DELEGATE events if
 * charproof ever rewrites entries behind our back.
 */
export class CharproofKeyCustody implements KeyCustody {
  private async lib() {
    const charproof = await import("charproof");
    const { getDb } = await import("./firebase-client");
    const fb = await import("firebase/auth");
    const { getApps } = await import("firebase/app");
    await getDb(); // ensures the app exists before getAuth
    charproof.initializeZK({
      db: (await import("firebase/firestore")).getFirestore(getApps()[0]),
      auth: fb.getAuth(getApps()[0]),
    });
    // AMK bootstrap (genesis on first device, keyring unwrap on later ones).
    await charproof.getActiveAmk();
    return charproof;
  }

  async getIdentity(rosterLedgerId: string): Promise<SigningKeyPair | null> {
    const cp = await this.lib();
    const creds = await cp.loadFromKeystore(rosterLedgerId);
    if (!creds) return null;
    return { publicKeyB64: creds.signingPublicKey, privateKeyB64: creds.signingPrivateKey };
  }

  async ensureIdentity(rosterLedgerId: string, rosterLedgerKey: string): Promise<SigningKeyPair> {
    const existing = await this.getIdentity(rosterLedgerId);
    if (existing) return existing;
    const cp = await this.lib();
    const pair = await generateSigningKeyPair();
    await cp.saveToKeystore(rosterLedgerId, {
      symmetricKey: rosterLedgerKey,
      signingPrivateKey: pair.privateKeyB64,
      signingPublicKey: pair.publicKeyB64,
    });
    return pair;
  }

  async getLedgerKey(ledgerId: string): Promise<string | null> {
    const cp = await this.lib();
    const creds = await cp.loadFromKeystore(ledgerId);
    return creds?.symmetricKey ?? null;
  }

  async saveLedgerKey(ledgerId: string, keyB64: string): Promise<void> {
    const cp = await this.lib();
    const existing = await cp.loadFromKeystore(ledgerId);
    if (existing) return;
    // Seed the claim ledger with the ROSTER identity (§4.1) — never a fresh key.
    const registry = await kvGet<string>("rosterLedgerId");
    const identity = registry ? await this.getIdentity(registry) : null;
    if (!identity) throw new Error("Enroll a signing identity before joining ledgers");
    await cp.saveToKeystore(ledgerId, {
      symmetricKey: keyB64,
      signingPrivateKey: identity.privateKeyB64,
      signingPublicKey: identity.publicKeyB64,
    });
  }

  async getRootPin(): Promise<string | null> {
    return kvGet<string>("rootPin");
  }
  async setRootPin(fingerprintHex: string): Promise<void> {
    await kvSet("rootPin", fingerprintHex);
  }
}

export function getCustody(backend: "mock" | "firestore"): KeyCustody {
  return backend === "mock" ? new LocalKeyCustody() : new CharproofKeyCustody();
}

/** Remember which roster this browser enrolled against (used by charproof
 *  custody to find the identity when seeding claim ledgers). */
export async function rememberRoster(rosterLedgerId: string): Promise<void> {
  await kvSet("rosterLedgerId", rosterLedgerId);
}
