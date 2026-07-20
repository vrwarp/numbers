import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { enqueueDeviceRequest } from "@/lib/notifications/enqueue";

export const runtime = "nodejs";

/**
 * §7.1b client-hinted self-event: the keyless server never sees charproof
 * device-approval requests (they live in Firestore), so the REQUESTING
 * device — already authenticated as the same user — posts this hint after
 * filing. Strictly self-scoped: it can only ever notify the caller's own
 * other devices. Dedupe is server-derived (15-min bucket) and a small hourly
 * cap bounds "spam yourself" (FCM quota, SQLite growth, health noise).
 */

const Schema = z.object({
  /** The requesting device's own FCM token, so it can be excluded from
   *  recipients. Resolved to OUR row id here — the raw value goes no further. */
  excludeToken: z.string().max(4096).optional(),
});

const HOURLY_CAP = 8;

export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const parsed = Schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) throw new ApiError(400, "Invalid hint", "push.invalidHint");

    const recent = await prisma.notificationJob.count({
      where: {
        userId,
        kind: "device-request",
        createdAt: { gte: new Date(Date.now() - 60 * 60_000) },
      },
    });
    if (recent >= HOURLY_CAP) {
      throw new ApiError(429, "Too many device-request hints", "push.hintRateLimited");
    }

    let excludeTokenId: string | undefined;
    if (parsed.data.excludeToken) {
      const row = await prisma.pushToken.findUnique({
        where: { token: parsed.data.excludeToken },
        select: { id: true, userId: true },
      });
      if (row && row.userId === userId) excludeTokenId = row.id;
    }

    await enqueueDeviceRequest(userId, excludeTokenId);
    return NextResponse.json({ ok: true }, { status: 202 });
  });
}
