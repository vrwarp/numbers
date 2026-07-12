/**
 * Parsing for the in-person vouch QR (docs/ESIGN_DESIGN.md §4.3). The
 * candidate's screen shows a QR encoding a `/vouch?c=<payload>` URL; the
 * voucher's in-page camera scanner (VouchQrScanner) decodes the image and
 * hands the text here. Pure string work — no DOM, no crypto — so it
 * unit-tests without a browser.
 *
 * The `c` payload is base64url(JSON {uid,email,name,publicKey}) and is
 * UNTRUSTED (anyone can craft a `/vouch?c=` URL): we only shape-check it.
 * The ceremony still recomputes the fingerprint from the embedded key and
 * requires the voucher's in-person human confirmation plus their own
 * signature, so a hostile QR can at most present an identity the voucher
 * must still deliberately vouch for.
 */

import type { VouchSubject } from "./client";

/** Decode a base64url `c` payload into a subject, or null if malformed. */
export function decodeSubject(c: string): VouchSubject | null {
  try {
    const json = atob(c.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = JSON.parse(json) as Partial<VouchSubject>;
    if (parsed.uid && parsed.email && parsed.publicKey) {
      return {
        uid: parsed.uid,
        email: parsed.email,
        name: parsed.name || parsed.email,
        publicKey: parsed.publicKey,
      };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Decode scanned QR text into a vouch subject, or null if it isn't a vouch
 * code (so the scanner keeps looking). Accepts a full `/vouch?c=<payload>`
 * URL from ANY origin — a QR generated on one deployment origin must still
 * work when the voucher's browser is on another — or the bare base64url
 * payload on its own.
 */
export function subjectFromScan(text: string): VouchSubject | null {
  const raw = text.trim();
  if (!raw) return null;
  try {
    const c = new URL(raw).searchParams.get("c");
    if (c) return decodeSubject(c);
  } catch {
    // not an absolute URL — treat the whole string as the payload below
  }
  return decodeSubject(raw);
}
