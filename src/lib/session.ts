import crypto from "crypto";
import { cookies } from "next/headers";
import { isAuthTestMode } from "@/lib/config";
import { configValue } from "@/lib/config-file";

/**
 * Stateless session layer: after Firebase verifies who the user is (once, at
 * sign-in), we issue our own HMAC-signed cookie carrying the DB user id. No
 * server-side session state, so sign-out is just clearing the cookie — same
 * property the previous JWT setup had.
 */

export const SESSION_COOKIE = "numbers_session";
// 90 days (was 30, an undeliberate default): usage is a ~week burst per
// claim, so 90 keeps most notification taps signed-in while expiry still
// only ever costs a Google re-auth — the e-sign device key lives in app
// storage, not this cookie (docs/NOTIFICATIONS_DESIGN.md §8.8/§15).
const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;

function secret(): Buffer {
  const s = configValue("AUTH_SECRET");
  if (!s) throw new Error("AUTH_SECRET must be set (openssl rand -base64 32)");
  return Buffer.from(s, "utf8");
}

function hmac(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Create a signed session token for a user id. `nowMs` is injectable for tests. */
export function signSessionToken(userId: string, nowMs = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, exp: Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS }),
    "utf8"
  ).toString("base64url");
  return `${payload}.${hmac(payload)}`;
}

/** Return the user id for a valid, unexpired token, or null. */
export function verifySessionToken(token: string, nowMs = Date.now()): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(hmac(payload));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof parsed.uid !== "string" || !parsed.uid) return null;
    if (typeof parsed.exp !== "number" || parsed.exp <= Math.floor(nowMs / 1000)) return null;
    return parsed.uid;
  } catch {
    return null;
  }
}

// E2E runs a production build over plain-http localhost, where WebKit drops
// Secure cookies — hence the test-mode escape hatch.
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: process.env.NODE_ENV === "production" && !isAuthTestMode(),
  };
}

/** Issue the session cookie for a user (route handlers only). */
export async function setSessionCookie(userId: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, signSessionToken(userId), {
    ...cookieOptions(),
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Remove the session cookie (route handlers only). */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
}
