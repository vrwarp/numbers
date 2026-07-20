import { NextResponse } from "next/server";
import { handleApi } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { prisma } from "@/lib/prisma";
import {
  isPushConfigured,
  isPushMock,
  isPushPaused,
  pushServiceAccountFingerprint,
  pushServiceAccountJson,
} from "@/lib/notifications/settings";

export const runtime = "nodejs";

/**
 * §12 admin health card, read-only: queue depth, last successful send,
 * recent failures, SA fingerprint (never the key) and the SA scope
 * self-check — the predictable failure mode of the console walkthrough is a
 * frustrated volunteer granting "Firebase Admin", which would silently void
 * the §4 keyless-ledger property, so the card warns about it in plain
 * language. Config editing (pause switch included) lives in the allowlisted
 * settings editor.
 */

type ScopeCheck = "ok" | "broad" | "unknown" | "mock" | "unconfigured";

/** §12: testIamPermissions-style probe — the SA reports which of these it
 *  holds. Holding the Firestore read permission = over-scoped. */
async function checkSaScope(): Promise<ScopeCheck> {
  if (isPushMock()) return "mock";
  const raw = pushServiceAccountJson();
  if (!raw) return "unconfigured";
  try {
    const projectId = (JSON.parse(raw) as { project_id?: string }).project_id;
    if (!projectId) return "unknown";
    const { getApps, initializeApp, cert } = await import("firebase-admin/app");
    const app =
      getApps().find((a) => a.name === "push") ??
      initializeApp({ credential: cert(JSON.parse(raw)) }, "push");
    const token = await app.options.credential?.getAccessToken();
    if (!token) return "unknown";
    const res = await fetch(
      `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:testIamPermissions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          permissions: ["cloudmessaging.messages.create", "datastore.entities.get"],
        }),
      }
    );
    if (!res.ok) return "unknown";
    const body = (await res.json()) as { permissions?: string[] };
    const granted = new Set(body.permissions ?? []);
    if (granted.has("datastore.entities.get")) return "broad";
    return granted.has("cloudmessaging.messages.create") ? "ok" : "unknown";
  } catch {
    return "unknown";
  }
}

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
      saScope: await checkSaScope(),
    });
  });
}
