import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { enqueueSelfTest } from "@/lib/notifications/enqueue";
import { isPushConfigured } from "@/lib/notifications/settings";

export const runtime = "nodejs";

/**
 * §8.7 self-test: "is this working?" answered in 30 seconds by the user
 * themselves, over the phone if need be. An ordinary catalog enqueue — it
 * exercises the real worker, real preferences, real tokens. Master switch
 * only; bypasses categories and the quiet window (§5).
 */
export async function POST() {
  return handleApi(async () => {
    const userId = await requireUserId();
    if (!isPushConfigured()) {
      throw new ApiError(409, "Push notifications are not configured", "push.notConfigured");
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { notifyEnabled: true },
    });
    if (!user?.notifyEnabled) {
      throw new ApiError(409, "Turn notifications on first", "push.notEnabled");
    }
    await enqueueSelfTest(userId);
    return NextResponse.json({ ok: true, sentAt: new Date().toISOString() });
  });
}
