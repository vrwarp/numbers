/**
 * Ledger event envelopes (docs/ESIGN_DESIGN.md §3): ECDSA P-256/SHA-256
 * signatures over the canonicalized action, wrapped as
 * `{publicKey, signature, action}` JSON and AES-256-GCM-encrypted (12-byte
 * IV) under the ledger's symmetric key — byte-compatible with charproof's
 * envelope so keys and history interoperate. Isomorphic (WebCrypto).
 */

import {
  canonicalStringify,
  bytesToBase64,
  base64ToBytes,
  actionHash,
} from "./canonical";
import type { RawLedgerEventDoc, RejectedEvent, VerifiedEvent } from "./types";

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto is not available in this environment");
  return c.subtle;
}

// --- Keys --------------------------------------------------------------------

export interface SigningKeyPair {
  publicKeyB64: string; // SPKI
  privateKeyB64: string; // PKCS8
}

export async function generateSigningKeyPair(): Promise<SigningKeyPair> {
  const pair = await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const spki = new Uint8Array(await subtle().exportKey("spki", pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey));
  return { publicKeyB64: bytesToBase64(spki), privateKeyB64: bytesToBase64(pkcs8) };
}

export async function importPrivateKey(privateKeyB64: string): Promise<CryptoKey> {
  return subtle().importKey(
    "pkcs8",
    base64ToBytes(privateKeyB64) as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

export async function importPublicKey(publicKeyB64: string): Promise<CryptoKey> {
  return subtle().importKey(
    "spki",
    base64ToBytes(publicKeyB64) as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
}

export async function generateLedgerKey(): Promise<string> {
  const key = await subtle().generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  return bytesToBase64(new Uint8Array(await subtle().exportKey("raw", key)));
}

export async function importLedgerKey(rawB64: string): Promise<CryptoKey> {
  return subtle().importKey(
    "raw",
    base64ToBytes(rawB64) as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

// --- Sign / verify -----------------------------------------------------------

export async function signAction(privateKeyB64: string, action: unknown): Promise<string> {
  const key = await importPrivateKey(privateKeyB64);
  const bytes = new TextEncoder().encode(canonicalStringify(action));
  const sig = await subtle().sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    key,
    bytes as BufferSource
  );
  return bytesToBase64(new Uint8Array(sig));
}

export async function verifyActionSignature(
  publicKeyB64: string,
  signatureB64: string,
  action: unknown
): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyB64);
    const bytes = new TextEncoder().encode(canonicalStringify(action));
    return await subtle().verify(
      { name: "ECDSA", hash: { name: "SHA-256" } },
      key,
      base64ToBytes(signatureB64) as BufferSource,
      bytes as BufferSource
    );
  } catch {
    return false;
  }
}

// --- Envelope encrypt / decrypt ----------------------------------------------

export interface EncryptedEnvelope {
  encryptedData: string;
  iv: string;
}

export async function sealEnvelope(
  ledgerKeyB64: string,
  signerPrivateKeyB64: string,
  signerPublicKeyB64: string,
  action: unknown
): Promise<EncryptedEnvelope> {
  const signature = await signAction(signerPrivateKeyB64, action);
  const envelopeJson = JSON.stringify({ publicKey: signerPublicKeyB64, signature, action });
  const key = await importLedgerKey(ledgerKeyB64);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(envelopeJson) as BufferSource
  );
  return {
    encryptedData: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

/**
 * Decrypt one raw event doc and check its embedded signature. Returns either
 * a VerifiedEvent or a RejectedEvent — never hides an undecryptable/invalid
 * event (§3: classified, not dropped). Envelope authorship beyond "the
 * signature matches the embedded key" is the reducers' job (stateAt checks).
 */
export async function openEnvelope(
  ledgerKeyB64: string,
  doc: RawLedgerEventDoc
): Promise<{ ok: VerifiedEvent } | { rejected: RejectedEvent }> {
  const reject = (reason: string) => ({
    rejected: { eventId: doc.eventId, createdAtMs: doc.createdAtMs, reason },
  });
  let json: string;
  try {
    const key = await importLedgerKey(ledgerKeyB64);
    const plain = await subtle().decrypt(
      { name: "AES-GCM", iv: base64ToBytes(doc.iv) as BufferSource },
      key,
      base64ToBytes(doc.encryptedData) as BufferSource
    );
    json = new TextDecoder().decode(plain);
  } catch {
    return reject("undecryptable (wrong key or junk write)");
  }
  let envelope: { publicKey?: string; signature?: string; action?: unknown };
  try {
    envelope = JSON.parse(json);
  } catch {
    return reject("envelope is not JSON");
  }
  if (!envelope.publicKey || !envelope.signature || envelope.action === undefined) {
    return reject("envelope missing publicKey/signature/action");
  }
  const valid = await verifyActionSignature(
    envelope.publicKey,
    envelope.signature,
    envelope.action
  );
  if (!valid) return reject("signature does not verify");
  return {
    ok: {
      eventId: doc.eventId,
      createdAtMs: doc.createdAtMs,
      signerPublicKey: envelope.publicKey,
      action: envelope.action as VerifiedEvent["action"],
      actionHash: await actionHash(envelope.action),
    },
  };
}

/** Open every doc in a ledger, ordered (createdAtMs, eventId), deduplicating
 *  replayed envelopes: the first occurrence of an actionHash wins. */
export async function openLedger(
  ledgerKeyB64: string,
  docs: RawLedgerEventDoc[]
): Promise<{ events: VerifiedEvent[]; rejected: RejectedEvent[] }> {
  const sorted = [...docs].sort(
    (a, b) => a.createdAtMs - b.createdAtMs || (a.eventId < b.eventId ? -1 : 1)
  );
  // Envelopes open concurrently (decrypt + ECDSA verify interleave in
  // WebCrypto); dedup walks the results in sorted order below, so the
  // outcome is identical to opening one at a time.
  const opened = await Promise.all(sorted.map((doc) => openEnvelope(ledgerKeyB64, doc)));
  const events: VerifiedEvent[] = [];
  const rejected: RejectedEvent[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    const doc = sorted[i];
    const result = opened[i];
    if ("rejected" in result) {
      rejected.push(result.rejected);
      continue;
    }
    if (seen.has(result.ok.actionHash)) {
      rejected.push({
        eventId: doc.eventId,
        createdAtMs: doc.createdAtMs,
        reason: "duplicate action (replayed envelope)",
      });
      continue;
    }
    seen.add(result.ok.actionHash);
    events.push(result.ok);
  }
  return { events, rejected };
}
