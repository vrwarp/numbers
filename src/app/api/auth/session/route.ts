import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleApi, ApiError } from "@/lib/api";
import { isFirebaseConfigured, verifyFirebaseIdToken } from "@/lib/firebase-admin";
import { setSessionCookie, clearSessionCookie } from "@/lib/session";
import { syncLocalePreference } from "@/i18n/cookie";

export const runtime = "nodejs";

/** Exchange a Firebase ID token (from the client SDK sign-in) for our session cookie. */
export async function POST(req: NextRequest) {
  return handleApi(async () => {
    if (!isFirebaseConfigured()) throw new ApiError(400, "Firebase sign-in is not configured");
    const body = await req.json().catch(() => null);
    const idToken = typeof body?.idToken === "string" ? body.idToken : "";
    if (!idToken) throw new ApiError(400, "idToken required");

    let decoded;
    try {
      decoded = await verifyFirebaseIdToken(idToken);
    } catch {
      throw new ApiError(401, "Invalid Firebase ID token");
    }

    // Users are keyed by email, so only accept identities Firebase has
    // verified the email for (always true for Google sign-in).
    const email = decoded.email?.trim().toLowerCase();
    if (!email || !decoded.email_verified) {
      throw new ApiError(401, "A verified email address is required");
    }

    const user = await prisma.user.upsert({
      where: { email },
      update: { firebaseUid: decoded.uid },
      create: {
        email,
        fullName: typeof decoded.name === "string" ? decoded.name : null,
        firebaseUid: decoded.uid,
      },
    });
    await setSessionCookie(user.id);
    await syncLocalePreference(user.id, user.locale);
    return NextResponse.json({ ok: true });
  });
}

/** Sign out: the token is stateless, so clearing the cookie is all there is. */
export async function DELETE() {
  return handleApi(async () => {
    await clearSessionCookie();
    return NextResponse.json({ ok: true });
  });
}
