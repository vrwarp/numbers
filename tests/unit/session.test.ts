import { beforeAll, describe, expect, it } from "vitest";
import { signSessionToken, verifySessionToken } from "@/lib/session";

beforeAll(() => {
  process.env.AUTH_SECRET = "unit-test-secret";
});

describe("session tokens", () => {
  it("round-trips a user id", () => {
    const token = signSessionToken("user_123");
    expect(verifySessionToken(token)).toBe("user_123");
  });

  it("rejects a tampered payload", () => {
    const token = signSessionToken("user_123");
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: "user_evil", exp: 9999999999 })).toString(
      "base64url"
    );
    expect(verifySessionToken(`${forged}.${sig}`)).toBeNull();
    expect(verifySessionToken(`${payload}.AAAA${sig.slice(4)}`)).toBeNull();
  });

  it("rejects an expired token", () => {
    const thirtyOneDaysMs = 31 * 24 * 60 * 60 * 1000;
    const token = signSessionToken("user_123", Date.now() - thirtyOneDaysMs);
    expect(verifySessionToken(token)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(verifySessionToken("")).toBeNull();
    expect(verifySessionToken("not-a-token")).toBeNull();
    expect(verifySessionToken("a.b.c")).toBeNull();
  });

  it("rejects tokens signed with a different secret", () => {
    const token = signSessionToken("user_123");
    process.env.AUTH_SECRET = "another-secret";
    expect(verifySessionToken(token)).toBeNull();
    process.env.AUTH_SECRET = "unit-test-secret";
  });
});
