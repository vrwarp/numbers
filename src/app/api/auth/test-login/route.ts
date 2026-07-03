import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleApi, ApiError } from "@/lib/api";
import { isAuthTestMode } from "@/lib/config";
import { setSessionCookie } from "@/lib/session";

export const runtime = "nodejs";

/** Passwordless dev login. Exists only when AUTH_TEST_MODE=1 (Playwright / offline dev). */
export async function POST(req: NextRequest) {
  return handleApi(async () => {
    if (!isAuthTestMode()) throw new ApiError(404, "Not found");
    const body = await req.json().catch(() => null);
    const email = String(body?.email ?? "").trim().toLowerCase();
    if (!email) throw new ApiError(400, "email required");
    const name = String(body?.name ?? "") || email.split("@")[0];

    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email, fullName: name },
    });
    await setSessionCookie(user.id);
    return NextResponse.json({ ok: true });
  });
}
