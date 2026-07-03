import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

/**
 * Firebase Authentication handles identity (Google sign-in in the browser);
 * the server exchanges a verified Firebase ID token for its own signed
 * session cookie (src/lib/session.ts) via POST /api/auth/session. Everything
 * downstream only ever sees the DB user id resolved here.
 *
 * AUTH_TEST_MODE=1 adds a passwordless "Dev Login" (POST /api/auth/test-login)
 * so Playwright (and local dev without Firebase) can authenticate.
 */

/** Resolve the current DB user id, or null if unauthenticated. */
export async function currentUserId(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

/** Load the signed-in user's row, or null if unauthenticated (or deleted). */
export async function currentUser() {
  const userId = await currentUserId();
  if (!userId) return null;
  return prisma.user.findUnique({ where: { id: userId } });
}
