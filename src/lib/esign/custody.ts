"use client";

/**
 * Key custody (docs/ESIGN_DESIGN.md §4, docs/MULTI_DEVICE_PLAN.md). The
 * member's church identity is their roster-ledger keypair; claim ledgers are
 * seeded with that SAME keypair (§4.1) so one vouched key signs everything.
 *
 * Custody always runs charproof's real device/keystore code — the AMK keyring,
 * device enrollment, phrase/PRF recovery, and revocation all come from the
 * library. What varies per backend is only persistence (M1/D1):
 *
 * - mock (ESIGN_MOCK): providers injected via setDeviceServiceProviders — a
 *   SQLite-backed AccountKeyStore over /api/esign-mock/device-sync/*, the
 *   numbers session as the auth provider, and a per-browser-context mock
 *   passkey. Identical ceremony semantics, no Firebase.
 * - firestore (production): charproof's default Firestore providers, after
 *   initializeZK against our lazily-loaded Firebase app.
 *
 * The TOFU root-fingerprint pin (§4.6) and the enrolled roster id stay in
 * plain per-device IndexedDB on purpose: trust in the root anchor must be
 * re-established by each device, never inherited from a syncable blob.
 */

import { generateSigningKeyPair, type SigningKeyPair } from "./envelope";

export type DeviceStatus =
  /** No account-keys document anywhere — enrolling here runs genesis. */
  | "fresh"
  /** This device can unwrap the AMK — keystore (and identity) available. */
  | "ready"
  /** The account has keys but THIS device isn't authorized for them. */
  | "unrecognized";

export interface KeyCustody {
  /** The member's identity keypair (roster keypair), if available on this device. */
  getIdentity(rosterLedgerId: string): Promise<SigningKeyPair | null>;
  /** Create-or-load the identity keypair for this roster. */
  ensureIdentity(rosterLedgerId: string, rosterLedgerKey: string): Promise<SigningKeyPair>;
  getLedgerKey(ledgerId: string): Promise<string | null>;
  saveLedgerKey(ledgerId: string, keyB64: string): Promise<void>;
  getRootPin(): Promise<string | null>;
  setRootPin(fingerprintHex: string): Promise<void>;
  /** Where this browser stands in the member's device fleet (§M2). */
  deviceStatus(): Promise<DeviceStatus>;
}

/** An AMK the current device cannot unwrap (or a refused/missing passkey). */
export function isUnrecognizedDeviceError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "NotAllowedError") return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("UNRECOGNIZED_DEVICE") || message.includes("Account keys missing");
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

// --- charproof custody (both backends) ------------------------------------------

export interface CustodyUser {
  userId: string;
  email: string;
  name: string;
}

/** "Chrome on Linux", "Safari on an iPhone" — what the approval banner and
 *  devices panel call this browser. Members can't tell device ids apart;
 *  they CAN tell their phone from their laptop. */
function friendlyDeviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "A browser";
  const platform = /iPhone/.test(ua)
    ? "an iPhone"
    : /iPad/.test(ua)
      ? "an iPad"
      : /Android/.test(ua)
        ? "an Android device"
        : /Mac/.test(ua)
          ? "a Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux|CrOS/.test(ua)
              ? "Linux"
              : "a device";
  return `${browser} on ${platform}`;
}

/** Load charproof with the right persistence providers for this backend.
 *  Shared by custody and the device-management ops (devices.ts). */
export async function esignCharproof(
  backend: "mock" | "firestore",
  user: CustodyUser
): Promise<typeof import("charproof")> {
  const charproof = await import("charproof");
  if (backend === "mock") {
    const { initMockDeviceProviders } = await import("./device-sync");
    initMockDeviceProviders(charproof, user);
  } else {
    const { ensureFirebaseAuth, getDb, isEmulatorConfigured } = await import("./firebase-client");
    const fb = await import("firebase/auth");
    const { getApps } = await import("firebase/app");
    await getDb(); // ensures the app exists (and emulator wiring) before getAuth
    // charproof's device/keystore stores address docs by request.auth.uid —
    // sign in (popup in prod, silent email/password on the emulator) first.
    await ensureFirebaseAuth();
    charproof.initializeZK({
      db: (await import("firebase/firestore")).getFirestore(getApps()[0]),
      auth: fb.getAuth(getApps()[0]),
      // Request a discoverable PLATFORM passkey (charproof ≥1.0.10). Its default
      // residentKey:"required" is what makes Android Chrome route credential
      // creation to Google Password Manager — which provisions the PRF/hmac-secret
      // the AMK genesis needs — instead of the legacy security-key chooser, which
      // yields no PRF. Pinning platform additionally skips the cross-device chooser
      // so members land straight on the fingerprint prompt (the church is all
      // phones/laptops; roaming security keys aren't a recovery path here). The
      // default userVerification "discouraged" is kept, matching credentials sealed
      // by earlier versions so their recovery is unchanged. Overridden by the mock
      // provider below when the emulator is configured.
      prf: { authenticatorAttachment: "platform" },
    });
    if (isEmulatorConfigured()) {
      // Headless e2e can't drive real WebAuthn; the emulator-gated mock
      // passkey is charproof's supported injection point (LetUsMeet does the
      // same). Production configs never carry the emulator block.
      const { MockPrfProvider } = await import("./device-sync");
      charproof.setPrfProviders({ prfProvider: new MockPrfProvider() });
    }
  }
  // Name the device once, before its name is sealed into any request or
  // genesis document (kept if the member ever renames it).
  try {
    if (!localStorage.getItem("deviceName")) charproof.setDeviceName(friendlyDeviceName());
  } catch {
    // storage unavailable (private mode) — charproof falls back internally
  }
  return charproof;
}

export class CharproofKeyCustody implements KeyCustody {
  constructor(
    private backend: "mock" | "firestore",
    private user: CustodyUser,
    /** Known roster id from the registry — devices that joined via
     *  authorization/recovery never ran enroll(), so the local marker
     *  may not exist (M2). */
    private rosterLedgerId?: string
  ) {}

  private async lib() {
    return esignCharproof(this.backend, this.user);
  }

  async deviceStatus(): Promise<DeviceStatus> {
    const cp = await this.lib();
    if (!(await cp.hasAccountKeys())) return "fresh";
    return (await cp.verifyAmk()) ? "ready" : "unrecognized";
  }

  async getIdentity(rosterLedgerId: string): Promise<SigningKeyPair | null> {
    const cp = await this.lib();
    try {
      const creds = await cp.loadFromKeystore(rosterLedgerId);
      if (!creds) return null;
      return { publicKeyB64: creds.signingPublicKey, privateKeyB64: creds.signingPrivateKey };
    } catch (err) {
      if (isUnrecognizedDeviceError(err)) return null;
      throw err;
    }
  }

  async ensureIdentity(rosterLedgerId: string, rosterLedgerKey: string): Promise<SigningKeyPair> {
    const existing = await this.getIdentity(rosterLedgerId);
    if (existing) return existing;
    const cp = await this.lib();
    // Refuse to mint a fresh key on an unauthorized device of an existing
    // account: that would fork the member's identity. M2's new-device flow
    // (approve / recover) is the way back in.
    if (!(await cp.hasAccountKeys()) || (await cp.verifyAmk())) {
      const pair = await generateSigningKeyPair();
      await cp.saveToKeystore(rosterLedgerId, {
        symmetricKey: rosterLedgerKey,
        signingPrivateKey: pair.privateKeyB64,
        signingPublicKey: pair.publicKeyB64,
      });
      return pair;
    }
    throw new Error(
      "UNRECOGNIZED_DEVICE: this browser isn't authorized for your signing identity yet"
    );
  }

  async getLedgerKey(ledgerId: string): Promise<string | null> {
    const cp = await this.lib();
    try {
      const creds = await cp.loadFromKeystore(ledgerId);
      return creds?.symmetricKey ?? null;
    } catch (err) {
      if (isUnrecognizedDeviceError(err)) return null;
      throw err;
    }
  }

  async saveLedgerKey(ledgerId: string, keyB64: string): Promise<void> {
    const cp = await this.lib();
    const existing = await cp.loadFromKeystore(ledgerId);
    if (existing) return;
    // Seed the claim ledger with the ROSTER identity (§4.1) — never a fresh key.
    const registry = this.rosterLedgerId ?? (await kvGet<string>("rosterLedgerId"));
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

export function getCustody(
  backend: "mock" | "firestore",
  user: CustodyUser,
  rosterLedgerId?: string
): KeyCustody {
  return new CharproofKeyCustody(backend, user, rosterLedgerId);
}

/** Remember which roster this browser enrolled against (used by custody to
 *  find the identity when seeding claim ledgers). */
export async function rememberRoster(rosterLedgerId: string): Promise<void> {
  await kvSet("rosterLedgerId", rosterLedgerId);
}
