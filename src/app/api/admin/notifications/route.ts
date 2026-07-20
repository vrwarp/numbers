import { NextResponse } from "next/server";
import { handleApi } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { prisma } from "@/lib/prisma";
import {
  isPushConfigured,
  isPushMock,
  isPushPaused,
  pushServiceAccountFingerprint,
  serviceAccountScopeCheck,
} from "@/lib/notifications/settings";

export const runtime = "nodejs";

/**
 * §12 admin health card, read-only: queue depth, last successful send,
 * recent failures, SA fingerprint (never the key) and the SA scope
 * self-check — the predictable failure mode of the console walkthrough is a
 * frustrated volunteer granting "Firebase Admin", which would silently void
 * the §4 keyless-ledger property, so the card warns about it in plain
 * language. Config editing (pause switch included) lives in the allowlisted
 * settings editor. The scope self-check itself lives in
 * notifications/settings.ts so the setup wizard can reuse it on a draft.
 */

export async function GET() {
  return handleApi(async () => {
    await requireAdmin();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);
    const [queued, failedRecent, lastSent, tokenCount] = await Promise.all([
      prisma.notificationJob.count({ where: { status: { in: ["queued", "running"] } } }),
      prisma.notificationJob.count({ where: { status: "failed", createdAt: { gte: dayAgo } } }),
      prisma.notificationJob.findFirst({
        where: { status: "sent" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      prisma.pushToken.count(),
    ]);
    return NextResponse.json({
      configured: isPushConfigured(),
      mock: isPushMock(),
      paused: isPushPaused(),
      queueDepth: queued,
      failedLast24h: failedRecent,
      lastSentAt: lastSent?.createdAt ?? null,
      // Small-N flooring (§12): token counts identify people at this scale.
      devices: tokenCount < 5 ? null : tokenCount,
      saFingerprint: pushServiceAccountFingerprint(),
      saScope: await serviceAccountScopeCheck(),
    });
  });
}
