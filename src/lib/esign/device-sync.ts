"use client";

/**
 * Mock-mode providers for charproof's device/keystore machinery
 * (docs/MULTI_DEVICE_PLAN.md M1/D1). In ESIGN_MOCK we run charproof's REAL
 * deviceService/recovery code and swap only its persistence:
 *
 * - MockDeviceSyncStore  → the /api/esign-mock/device-sync/* SQLite routes,
 *   with polling standing in for Firestore snapshots and CAS-retry standing
 *   in for transactions.
 * - NumbersAuthProvider  → the numbers session user (no Firebase).
 * - MockPrfProvider      → a per-browser-context "passkey" (ported from
 *   LetUsMeet's e2e provider): credentials live in localStorage, and an
 *   assertion for a credential that doesn't exist here rejects with
 *   NotAllowedError — exactly how a real authenticator reports a passkey
 *   that lives on another device, which is what drives the
 *   "unrecognized device" gate honestly in tests.
 *
 * Production never reaches this module: firestore-backend custody keeps
 * charproof's default Firestore providers (see custody.ts).
 */

import type {
  setDeviceServiceProviders as SetDeviceServiceProviders,
  setPrfProviders as SetPrfProviders,
} from "charproof";

type DeviceProviders = Parameters<typeof SetDeviceServiceProviders>[0];
type AccountKeyStoreT = NonNullable<DeviceProviders["accountKeyStore"]>;
type AuthProviderT = NonNullable<DeviceProviders["authProvider"]>;
type PrfProviderT = NonNullable<Parameters<typeof SetPrfProviders>[0]["prfProvider"]>;
type AccountKeysDocumentT = NonNullable<Awaited<ReturnType<AccountKeyStoreT["getAccountKeys"]>>>;
type PendingDeviceT = NonNullable<Awaited<ReturnType<AccountKeyStoreT["getPendingDevice"]>>>;
type KeystoreEntryT = NonNullable<Awaited<ReturnType<AccountKeyStoreT["getKeystoreEntry"]>>>;

export interface DeviceSyncUser {
  userId: string;
  email: string;
  name: string;
}

const BASE = "/api/esign-mock/device-sync";
const POLL_MS = 1200;

async function jsonOrThrow(res: Response) {
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `Device sync failed (${res.status})`);
  return data;
}

function poll<T>(
  fetcher: () => Promise<T>,
  onSnapshot: (value: T) => void,
  onError?: (error: Error) => void
): () => void {
  let stopped = false;
  let last: string | null = null;
  const tick = async () => {
    try {
      const value = await fetcher();
      const key = JSON.stringify(value);
      if (!stopped && key !== last) {
        last = key;
        onSnapshot(value);
      }
    } catch (err) {
      if (!stopped) onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };
  void tick();
  const interval = setInterval(tick, POLL_MS);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

export class MockDeviceSyncStore implements AccountKeyStoreT {
  async getAccountKeys(): Promise<AccountKeysDocumentT | null> {
    const data = await jsonOrThrow(await fetch(`${BASE}/account-keys`));
    return (data.doc as AccountKeysDocumentT) ?? null;
  }

  private async getWithVersion(): Promise<{ doc: AccountKeysDocumentT | null; version: number }> {
    const data = await jsonOrThrow(await fetch(`${BASE}/account-keys`));
    return { doc: (data.doc as AccountKeysDocumentT) ?? null, version: data.version as number };
  }

  private async casWrite(
    updater: (current: AccountKeysDocumentT) => AccountKeysDocumentT | Promise<AccountKeysDocumentT>,
    pending?: { deviceId: string; patch: Record<string, unknown> }
  ): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const { doc, version } = await this.getWithVersion();
      if (!doc) throw new Error("Account keys missing.");
      const next = await updater(structuredClone(doc));
      const res = await fetch(`${BASE}/account-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc: next, baseVersion: version, pending }),
      });
      if (res.ok) return;
      if (res.status !== 409) await jsonOrThrow(res); // throws with the server's error
      await new Promise((r) => setTimeout(r, 60 + Math.random() * 120));
    }
    throw new Error("Device sync transaction kept conflicting — try again");
  }

  async transactAccountKeys(
    updater: (current: AccountKeysDocumentT) => AccountKeysDocumentT | Promise<AccountKeysDocumentT>
  ): Promise<void> {
    await this.casWrite(updater);
  }

  async setAccountKeys(doc: AccountKeysDocumentT): Promise<void> {
    await jsonOrThrow(
      await fetch(`${BASE}/account-keys`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc }),
      })
    );
  }

  async createAccountKeys(doc: AccountKeysDocumentT): Promise<boolean> {
    const data = await jsonOrThrow(
      await fetch(`${BASE}/account-keys`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc, create: true }),
      })
    );
    return data.created === true;
  }

  async getKeystoreEntry(docId: string): Promise<KeystoreEntryT | null> {
    const data = await jsonOrThrow(await fetch(`${BASE}/keystore/${encodeURIComponent(docId)}`));
    return (data.entry as KeystoreEntryT) ?? null;
  }

  async setKeystoreEntry(docId: string, entry: KeystoreEntryT): Promise<void> {
    await jsonOrThrow(
      await fetch(`${BASE}/keystore/${encodeURIComponent(docId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      })
    );
  }

  async setKeystoreArchivedStatus(docId: string, isArchived: boolean): Promise<void> {
    await jsonOrThrow(
      await fetch(`${BASE}/keystore/${encodeURIComponent(docId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isArchived }),
      })
    );
  }

  async getPendingDevice(deviceId: string): Promise<PendingDeviceT | null> {
    const data = await jsonOrThrow(await fetch(`${BASE}/pending/${encodeURIComponent(deviceId)}`));
    return (data.device as PendingDeviceT) ?? null;
  }

  async setPendingDevice(deviceId: string, data: PendingDeviceT): Promise<void> {
    await jsonOrThrow(
      await fetch(`${BASE}/pending/${encodeURIComponent(deviceId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      })
    );
  }

  async transactApproveDevice(
    accountUpdater: (
      current: AccountKeysDocumentT
    ) => AccountKeysDocumentT | Promise<AccountKeysDocumentT>,
    pendingDeviceId: string,
    pendingUpdate: Partial<PendingDeviceT>
  ): Promise<void> {
    await this.casWrite(accountUpdater, {
      deviceId: pendingDeviceId,
      patch: pendingUpdate as Record<string, unknown>,
    });
  }

  subscribePendingDevices(
    onSnapshot: (devices: PendingDeviceT[]) => void,
    onError?: (error: Error) => void
  ): () => void {
    return poll(
      async () => (await jsonOrThrow(await fetch(`${BASE}/pending`))).devices as PendingDeviceT[],
      onSnapshot,
      onError
    );
  }

  subscribePendingDevice(
    deviceId: string,
    onSnapshot: (device: PendingDeviceT | null) => void,
    onError?: (error: Error) => void
  ): () => void {
    return poll(() => this.getPendingDevice(deviceId), onSnapshot, onError);
  }

  subscribeAccountKeys(
    onSnapshot: (doc: AccountKeysDocumentT | null) => void,
    onError?: (error: Error) => void
  ): () => void {
    return poll(() => this.getAccountKeys(), onSnapshot, onError);
  }

  subscribeKeystore(
    onSnapshot: (entries: KeystoreEntryT[]) => void,
    onError?: (error: Error) => void
  ): () => void {
    return poll(
      async () => (await jsonOrThrow(await fetch(`${BASE}/keystore`))).entries as KeystoreEntryT[],
      onSnapshot,
      onError
    );
  }

  async deletePendingDevice(deviceId: string): Promise<void> {
    await jsonOrThrow(
      await fetch(`${BASE}/pending/${encodeURIComponent(deviceId)}`, { method: "DELETE" })
    );
  }

  async resetRemoteStore(): Promise<void> {
    await jsonOrThrow(await fetch(`${BASE}/account-keys`, { method: "DELETE" }));
  }
}

class NumbersAuthProvider implements AuthProviderT {
  constructor(private user: DeviceSyncUser) {}
  getCurrentUser() {
    return {
      uid: this.user.userId,
      isAnonymous: false,
      email: this.user.email,
      displayName: this.user.name,
    };
  }
}

// --- Mock "passkey" (per browser context, i.e. per walkthrough device) ---------

interface StoredCredential {
  userId: string;
  credentialId: string;
  prfResultB64: string;
}

const PRF_STORE_KEY = "numbers-esign-mock-prf";

function loadCredentials(): StoredCredential[] {
  try {
    return JSON.parse(localStorage.getItem(PRF_STORE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveCredentials(creds: StoredCredential[]): void {
  try {
    localStorage.setItem(PRF_STORE_KEY, JSON.stringify(creds));
  } catch {
    // private mode / quota — non-fatal in dev
  }
}

function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export class MockPrfProvider implements PrfProviderT {
  async createCredential(userId: string): Promise<{ credentialId: string; prfResult: Uint8Array }> {
    const creds = loadCredentials();
    const existing = creds.find((c) => c.userId === userId);
    if (existing) {
      return {
        credentialId: existing.credentialId,
        prfResult: Uint8Array.from(atob(existing.prfResultB64), (c) => c.charCodeAt(0)),
      };
    }
    const prfResult = crypto.getRandomValues(new Uint8Array(32));
    const credentialId = `mockcred_${userId}_${toB64(crypto.getRandomValues(new Uint8Array(6))).replace(/[^a-zA-Z0-9]/g, "")}`;
    creds.push({ userId, credentialId, prfResultB64: toB64(prfResult) });
    saveCredentials(creds);
    return { credentialId, prfResult };
  }

  async getAssertion(
    credentialIds: string[]
  ): Promise<{ usedCredentialId: string; prfResult: Uint8Array }> {
    const match = loadCredentials().find((c) => credentialIds.includes(c.credentialId));
    if (!match) {
      // The "passkey" lives on another device — same signal a real authenticator gives.
      throw new DOMException("No matching credential on this device.", "NotAllowedError");
    }
    return {
      usedCredentialId: match.credentialId,
      prfResult: Uint8Array.from(atob(match.prfResultB64), (c) => c.charCodeAt(0)),
    };
  }
}

// --- Wiring -----------------------------------------------------------------------

let providersForUid: string | null = null;

/**
 * Idempotent per-user provider injection. On a user switch (shared browser)
 * charproof's module-level AMK/PRF session caches are cleared first, mirroring
 * LetUsMeet's auth-change handling.
 */
export function initMockDeviceProviders(
  charproof: typeof import("charproof"),
  user: DeviceSyncUser
): void {
  if (providersForUid === user.userId) return;
  if (providersForUid !== null) {
    charproof.clearAmkSessionCache();
    charproof.clearPrfSessionCache();
  }
  const accountKeyStore = new MockDeviceSyncStore();
  const authProvider = new NumbersAuthProvider(user);
  charproof.setDeviceServiceProviders({ accountKeyStore, authProvider });
  charproof.setPrfProviders({ authProvider, prfProvider: new MockPrfProvider() });
  charproof.setRecoveryProviders({ accountKeyStore, authProvider });
  providersForUid = user.userId;
}
