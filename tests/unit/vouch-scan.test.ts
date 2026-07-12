import { describe, expect, it } from "vitest";
import { decodeSubject, subjectFromScan } from "@/lib/esign/vouch-scan";

/** Encode a payload the way SigningIdentityCard builds the vouch QR. */
function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const subject = {
  uid: "u_123",
  email: "jane@example.org",
  name: "Jane Doe",
  publicKey: "BASE64_SPKI_KEY",
};
const payload = encode(subject);

describe("decodeSubject", () => {
  it("decodes a well-formed base64url payload", () => {
    expect(decodeSubject(payload)).toEqual(subject);
  });

  it("defaults name to email when name is absent", () => {
    const c = encode({ uid: "u", email: "a@b.co", publicKey: "K" });
    expect(decodeSubject(c)).toEqual({ uid: "u", email: "a@b.co", name: "a@b.co", publicKey: "K" });
  });

  it("rejects a payload missing required fields", () => {
    expect(decodeSubject(encode({ uid: "u", email: "a@b.co" }))).toBeNull();
    expect(decodeSubject(encode({ email: "a@b.co", publicKey: "K" }))).toBeNull();
  });

  it("rejects malformed base64 / non-JSON", () => {
    expect(decodeSubject("!!!not base64!!!")).toBeNull();
    expect(decodeSubject(encode(["not", "an", "object"]))).toBeNull();
  });
});

describe("subjectFromScan", () => {
  it("extracts the subject from a full /vouch URL", () => {
    expect(subjectFromScan(`https://numbers.example.com/vouch?c=${payload}`)).toEqual(subject);
  });

  it("is origin-agnostic (QR made on one deployment, scanned on another)", () => {
    expect(subjectFromScan(`https://other-host.church/vouch?c=${payload}`)).toEqual(subject);
    expect(subjectFromScan(`http://localhost:3000/vouch?c=${payload}`)).toEqual(subject);
  });

  it("tolerates extra query params in any order", () => {
    expect(subjectFromScan(`https://x.test/vouch?lang=en&c=${payload}&ref=qr`)).toEqual(subject);
  });

  it("accepts the bare base64url payload on its own", () => {
    expect(subjectFromScan(payload)).toEqual(subject);
    expect(subjectFromScan(`  ${payload}  `)).toEqual(subject);
  });

  it("returns null for a URL without a c param", () => {
    expect(subjectFromScan("https://numbers.example.com/vouch")).toBeNull();
    expect(subjectFromScan("https://example.com/verify?doc=abc123")).toBeNull();
  });

  it("returns null for arbitrary non-vouch QR content", () => {
    expect(subjectFromScan("WIFI:S:MyNetwork;T:WPA;P:secret;;")).toBeNull();
    expect(subjectFromScan("https://example.com/")).toBeNull();
    expect(subjectFromScan("")).toBeNull();
    expect(subjectFromScan("   ")).toBeNull();
  });

  it("does not misread a c-substring inside another param name", () => {
    // `doc=…` must not be mistaken for `c=…`.
    expect(subjectFromScan(`https://x.test/vouch?doc=${payload}`)).toBeNull();
  });
});
