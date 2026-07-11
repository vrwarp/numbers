import { describe, expect, it } from "vitest";
import {
  actionHash,
  canonicalStringify,
  fingerprintDisplay,
  fingerprintMatches,
  keyFingerprint,
  normalizeFingerprintInput,
  sha256Hex,
} from "@/lib/esign/canonical";
import {
  generateLedgerKey,
  generateSigningKeyPair,
  openEnvelope,
  openLedger,
  sealEnvelope,
  verifyActionSignature,
} from "@/lib/esign/envelope";

describe("canonicalStringify (charproof-compatible)", () => {
  it("sorts keys and drops undefined values", () => {
    expect(canonicalStringify({ b: 1, a: 2, c: undefined })).toBe('{"a":2,"b":1}');
  });
  it("recurses into arrays and objects", () => {
    expect(canonicalStringify({ z: [{ b: 1, a: null }], y: "s" })).toBe(
      '{"y":"s","z":[{"a":null,"b":1}]}'
    );
  });
  it("escapes keys so distinct objects cannot collide", () => {
    const a = canonicalStringify({ ['a":1,"b']: 1 });
    const b = canonicalStringify({ a: 1, b: 1 });
    expect(a).not.toBe(b);
  });
});

describe("envelope round-trip", () => {
  it("seals, opens, and verifies; rejects tampering and wrong keys", async () => {
    const signer = await generateSigningKeyPair();
    const ledgerKey = await generateLedgerKey();
    const action = { t: "SUBMIT", seq: 1, totalCents: 12345, ledger: "L1" };
    const sealed = await sealEnvelope(ledgerKey, signer.privateKeyB64, signer.publicKeyB64, action);
    const doc = { eventId: "e1", createdAtMs: 1000, ...sealed };

    const opened = await openEnvelope(ledgerKey, doc);
    if (!("ok" in opened)) throw new Error("expected ok");
    expect(opened.ok.action).toEqual(action);
    expect(opened.ok.signerPublicKey).toBe(signer.publicKeyB64);
    expect(opened.ok.actionHash).toBe(await actionHash(action));

    // Wrong ledger key → classified, not thrown.
    const wrongKey = await generateLedgerKey();
    const wrong = await openEnvelope(wrongKey, doc);
    expect("rejected" in wrong).toBe(true);

    // Bit-flipped ciphertext → rejected (AES-GCM auth).
    const flipped = { ...doc, encryptedData: doc.encryptedData.slice(0, -4) + "AAAA" };
    expect("rejected" in (await openEnvelope(ledgerKey, flipped))).toBe(true);

    // Signature must not verify for a different action.
    expect(
      await verifyActionSignature(signer.publicKeyB64, "AAAA", { ...action, totalCents: 1 })
    ).toBe(false);
  });

  it("openLedger orders by (createdAtMs, eventId) and deduplicates replays", async () => {
    const signer = await generateSigningKeyPair();
    const ledgerKey = await generateLedgerKey();
    const sealed = await sealEnvelope(ledgerKey, signer.privateKeyB64, signer.publicKeyB64, {
      t: "X",
      n: 1,
    });
    // The same envelope replayed under a new event id must count once.
    const docs = [
      { eventId: "b", createdAtMs: 2000, ...sealed },
      { eventId: "a", createdAtMs: 1000, ...sealed },
    ];
    const { events, rejected } = await openLedger(ledgerKey, docs);
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe("a");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/duplicate/);
  });
});

describe("fingerprints", () => {
  it("display form is 8 bytes grouped; input form requires 16 bytes", async () => {
    const signer = await generateSigningKeyPair();
    const full = await keyFingerprint(signer.publicKeyB64);
    expect(full).toHaveLength(64);
    expect(fingerprintDisplay(full)).toMatch(/^([0-9a-f]{2} ){7}[0-9a-f]{2}$/);
    // The 8-byte display form must NOT be accepted as input.
    expect(normalizeFingerprintInput(fingerprintDisplay(full))).toBeUndefined();
    const typed = normalizeFingerprintInput(full.slice(0, 32).toUpperCase() + "  ");
    expect(typed).toBe(full.slice(0, 32));
    expect(fingerprintMatches(full, typed!)).toBe(true);
    expect(fingerprintMatches(full, full.slice(1, 33))).toBe(false);
  });

  it("sha256Hex agrees with a known vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
