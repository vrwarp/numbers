/**
 * Canonicalization, hashing, and fingerprint conventions
 * (docs/ESIGN_DESIGN.md §3). Isomorphic: runs in the browser, in API
 * routes (Node ≥19 global WebCrypto), and in the offline verifier.
 *
 * canonicalStringify is byte-for-byte compatible with charproof's — the
 * signature input format is a cross-library contract, so two independent
 * implementations must agree exactly (undefined-valued keys dropped, keys
 * sorted, keys escaped via JSON.stringify).
 */

export function canonicalStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => canonicalStringify(item)).join(",") + "]";
  }
  const rec = obj as Record<string, unknown>;
  const keys = Object.keys(rec)
    .filter((key) => rec[key] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(rec[key])}`).join(",") +
    "}"
  );
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto is not available in this environment");
  return c.subtle;
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await subtle().digest("SHA-256", bytes as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

/** SHA-256 hex over the canonical form of an action — the cross-reference key
 *  (`submitRef`/`approveRef`/`closesRef`) and report idempotency key. */
export async function actionHash(action: unknown): Promise<string> {
  return sha256Hex(canonicalStringify(action));
}

/** Full key fingerprint: SHA-256 hex over the base64-decoded SPKI key. */
export async function keyFingerprint(publicKeyB64: string): Promise<string> {
  return sha256Hex(base64ToBytes(publicKeyB64));
}

/** Display form: first 8 bytes, hex, grouped in pairs ("a1 b2 c3 …"). */
export function fingerprintDisplay(fullHex: string): string {
  return (fullHex.slice(0, 16).match(/.{2}/g) ?? []).join(" ");
}

/**
 * Input form (§3): at least the first 16 bytes (32 hex chars). Normalizes
 * user-typed grouping/case; returns undefined when too short to be safe —
 * the 8-byte display form is never accepted as an input channel.
 */
export function normalizeFingerprintInput(raw: string): string | undefined {
  const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, "");
  return hex.length >= 32 ? hex : undefined;
}

/** Whether `fullHex` (64 hex chars) matches a normalized input prefix. */
export function fingerprintMatches(fullHex: string, inputHex: string): boolean {
  return inputHex.length >= 32 && fullHex.startsWith(inputHex);
}
