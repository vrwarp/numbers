import { prisma } from "@/lib/prisma";
import { configValue } from "@/lib/config-file";
import { isAiMock, isAuthTestMode } from "@/lib/config";
import { getRegistry } from "@/lib/esign/server";

/**
 * Server-computed admin dashboard: "problems" health checks + headline usage
 * stats. Health checks carry machine-readable codes (Admin.health.<code>) the
 * client localizes — same contract as API error codes. Money is only ever the
 * real `totalCents` of settled claims; no per-model pricing is invented.
 * SERVER ONLY.
 */

export type HealthLevel = "error" | "warn" | "info";

export interface HealthItem {
  level: HealthLevel;
  code: string;
  params?: Record<string, string | number>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function computeHealth(): Promise<HealthItem[]> {
  const items: HealthItem[] = [];
  const now = Date.now();

  // --- AI extraction readiness ---------------------------------------------
  if (isAiMock()) {
    items.push({ level: "info", code: "aiMock" });
  } else {
    const provider = (configValue("AI_PROVIDER") || "openrouter").toLowerCase();
    const keyVar = provider === "google" ? "GEMINI_API_KEY" : "OPENROUTER_API_KEY";
    if (!configValue(keyVar)?.trim()) {
      items.push({ level: "error", code: "aiNoKey", params: { provider, keyVar } });
    }
  }

  // --- Recent extraction failures ------------------------------------------
  const aiErrors24h = await prisma.extractionLog.count({
    where: { status: "error", createdAt: { gte: new Date(now - DAY_MS) } },
  });
  if (aiErrors24h > 0) items.push({ level: "warn", code: "aiErrors", params: { count: aiErrors24h } });

  // --- Church context -------------------------------------------------------
  const { loadChurchContext } = await import("@/lib/church-context");
  if (!(await loadChurchContext())) items.push({ level: "info", code: "contextMissing" });

  // --- Public URL / QR self-link -------------------------------------------
  if (!configValue("PUBLIC_BASE_URL")?.trim()) items.push({ level: "info", code: "publicUrlUnset" });

  // --- Sign-in configuration ------------------------------------------------
  const firebaseReady =
    !!configValue("FIREBASE_API_KEY")?.trim() &&
    !!configValue("FIREBASE_AUTH_DOMAIN")?.trim() &&
    !!configValue("FIREBASE_PROJECT_ID")?.trim();
  if (!firebaseReady && !isAuthTestMode()) items.push({ level: "warn", code: "firebaseIncomplete" });

  // --- E-sign state ---------------------------------------------------------
  const registry = await getRegistry();
  if (!registry) items.push({ level: "info", code: "esignNotSetUp" });
  else if (!registry.enabled) items.push({ level: "info", code: "esignDisabled" });

  // --- Stuck approvals ------------------------------------------------------
  const stuck = await prisma.reimbursement.count({
    where: { status: "submitted", submittedAt: { lt: new Date(now - 14 * DAY_MS) } },
  });
  if (stuck > 0) items.push({ level: "warn", code: "claimsStuck", params: { count: stuck, days: 14 } });

  return items;
}

export interface UsageStats {
  users: number;
  enrolledMembers: number;
  receipts: number;
  claimsByStatus: Record<string, number>;
  last7: { claims: number; receipts: number };
  last30: { claims: number; receipts: number };
  ai: {
    total: number;
    success: number;
    error: number;
    byKind: Record<string, number>;
    /** UTC-day buckets over the last 30 days (oldest → newest). */
    daily: { date: string; success: number; error: number }[];
  };
  provider: { name: string; model: string; mock: boolean };
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function computeStats(): Promise<UsageStats> {
  const now = Date.now();
  const since30 = new Date(now - 30 * DAY_MS);
  const since7 = new Date(now - 7 * DAY_MS);

  const [users, enrolledMembers, receipts, claimGroups, claims7, claims30, receipts7, receipts30, logs] =
    await Promise.all([
      prisma.user.count(),
      prisma.signerIdentity.count({ where: { status: "attested" } }),
      prisma.receipt.count(),
      prisma.reimbursement.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.reimbursement.count({ where: { createdAt: { gte: since7 } } }),
      prisma.reimbursement.count({ where: { createdAt: { gte: since30 } } }),
      prisma.receipt.count({ where: { createdAt: { gte: since7 } } }),
      prisma.receipt.count({ where: { createdAt: { gte: since30 } } }),
      prisma.extractionLog.findMany({
        where: { createdAt: { gte: since30 } },
        select: { status: true, kind: true, createdAt: true },
      }),
    ]);

  const claimsByStatus: Record<string, number> = {};
  for (const g of claimGroups) claimsByStatus[g.status] = g._count._all;

  const byKind: Record<string, number> = {};
  const dayMap = new Map<string, { success: number; error: number }>();
  // Seed every day so the chart has no gaps.
  for (let i = 29; i >= 0; i--) dayMap.set(utcDay(new Date(now - i * DAY_MS)), { success: 0, error: 0 });
  let success = 0;
  let error = 0;
  for (const log of logs) {
    byKind[log.kind] = (byKind[log.kind] ?? 0) + 1;
    const bucket = dayMap.get(utcDay(log.createdAt));
    if (log.status === "success") {
      success++;
      if (bucket) bucket.success++;
    } else {
      error++;
      if (bucket) bucket.error++;
    }
  }
  const daily = [...dayMap.entries()].map(([date, v]) => ({ date, ...v }));

  return {
    users,
    enrolledMembers,
    receipts,
    claimsByStatus,
    last7: { claims: claims7, receipts: receipts7 },
    last30: { claims: claims30, receipts: receipts30 },
    ai: { total: logs.length, success, error, byKind, daily },
    provider: {
      name: isAiMock() ? "mock" : (configValue("AI_PROVIDER") || "openrouter").toLowerCase(),
      model: isAiMock()
        ? "mock"
        : (configValue("AI_PROVIDER") || "openrouter").toLowerCase() === "google"
          ? configValue("GEMINI_MODEL") || "gemini-3.1-flash-lite"
          : configValue("OPENROUTER_MODEL") || "google/gemini-3.1-flash-lite",
      mock: isAiMock(),
    },
  };
}
