import { prisma } from "@/lib/prisma";
import { configValue } from "@/lib/config-file";
import type { Locale } from "@/lib/locales";
import { isLocale } from "@/lib/locales";
import type { NotificationParams } from "./catalog";
import { KIND_SPECS, eventExpired, isNotificationKind } from "./catalog";
import { composePush } from "./compose";
import { backoffMs, recipientWantsPush } from "./policy";
import { sendPush } from "./send";
import { isPushConfigured, isPushPaused, quietHoldForKind } from "./settings";

/**
 * Notification delivery worker (docs/NOTIFICATIONS_DESIGN.md §7.3): the
 * in-process singleton loop beside the embedding worker — lease-claimed jobs,
 * wake-on-enqueue, drain-after-restart. Preferences are consulted HERE (send
 * time), never at enqueue; job rows double as the activity list, so a
 * non-delivery finalizes as `skipped`, not deletion.
 */

const LEASE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 5;
/** Token liveness window (§7.3): max(lastSeenAt, lastSendOkAt) within 180 d —
 *  a successful send counts, because glance-only devices never ping. */
const TOKEN_LIVE_MS = 180 * 24 * 60 * 60_000;
/** Hard prune: FCM garbage-collects at ~270 d; keep rows a little past it. */
const TOKEN_PRUNE_MS = 270 * 24 * 60 * 60_000;
/** NotificationJob retention (§11): rows are the send log + activity list. */
const JOB_RETENTION_MS = 90 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;

function pollMs(): number {
  return Number(configValue("NOTIFY_POLL_MS") ?? 15_000);
}

function parseParams(payloadJson: string): NotificationParams | null {
  try {
    const parsed = JSON.parse(payloadJson) as NotificationParams;
    return typeof parsed.occurredAt === "string" ? parsed : null;
  } catch {
    return null;
  }
}

// Send-time preference/duty policy lives in ./policy.ts (pure, unit-tested).

async function finalize(
  jobId: string,
  data: { status: string; lastError?: string; attempts?: number; nextAttemptAt?: Date }
): Promise<void> {
  await prisma.notificationJob.updateMany({
    where: { id: jobId, status: "running" },
    data: { leaseExpiresAt: null, ...data },
  });
}

async function liveTokensOf(userId: string, now: Date) {
  const cutoff = new Date(now.getTime() - TOKEN_LIVE_MS);
  return prisma.pushToken.findMany({
    where: {
      userId,
      OR: [{ lastSeenAt: { gte: cutoff } }, { lastSendOkAt: { gte: cutoff } }],
    },
  });
}

/** Process one runnable job. Returns false when the queue is idle. */
async function processOne(): Promise<boolean> {
  if (!isPushConfigured() || isPushPaused()) return false;
  const now = new Date();

  await prisma.notificationJob.updateMany({
    where: { status: "running", leaseExpiresAt: { lt: now } },
    data: { status: "queued", nextAttemptAt: now, leaseExpiresAt: null },
  });

  const job = await prisma.notificationJob.findFirst({
    where: { status: "queued", nextAttemptAt: { lte: now } },
    orderBy: { createdAt: "asc" },
  });
  if (!job) return false;

  const claimed = await prisma.notificationJob.updateMany({
    where: { id: job.id, status: "queued" },
    data: { status: "running", leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
  });
  if (claimed.count === 0) return true; // raced; try the next one

  try {
    if (!isNotificationKind(job.kind)) {
      await finalize(job.id, { status: "skipped", lastError: "unknown-kind" });
      return true;
    }
    const kind = job.kind;
    const params = parseParams(job.payloadJson);
    // §7.3 age gate FIRST: FCM's TTL bounds time in FCM's queue, not ours —
    // a resurrected device-request must not fire "fresh" hours later.
    if (!params || eventExpired(kind, params.occurredAt, Date.now())) {
      await finalize(job.id, { status: "skipped", lastError: params ? "expired" : "bad-payload" });
      return true;
    }

    // Quiet window (dormant by default, §15 #2): hold-then-send, no attempt.
    const hold = quietHoldForKind(kind);
    if (hold > 0) {
      await prisma.notificationJob.updateMany({
        where: { id: job.id, status: "running" },
        data: { status: "queued", leaseExpiresAt: null, nextAttemptAt: new Date(Date.now() + hold) },
      });
      return true;
    }

    const user = await prisma.user.findUnique({
      where: { id: job.userId },
      select: {
        id: true,
        role: true,
        locale: true,
        notifyEnabled: true,
        notifySigning: true,
        notifyClaimProgress: true,
        notifyFinance: true,
        notifySecurity: true,
        notifyDiscreet: true,
        financePaused: true,
      },
    });
    if (!user || !recipientWantsPush(user, kind)) {
      await finalize(job.id, { status: "skipped", lastError: user ? "prefs" : "user-gone" });
      return true;
    }

    let tokens = await liveTokensOf(job.userId, new Date());
    // device-request: the requesting device never alerts itself (§7.1b).
    if (kind === "device-request" && params.excludeTokenId) {
      tokens = tokens.filter((t) => t.id !== params.excludeTokenId);
    }
    if (tokens.length === 0) {
      // §8.5: empty recipient set is skipped honestly, never pretended.
      await finalize(job.id, { status: "skipped", lastError: "no-tokens" });
      return true;
    }

    // Per-recipient finance coalescing (§5): the count is the recipient's
    // approved-unpaid queue at compose time.
    const count =
      kind === "finance-queue" ? await prisma.reimbursement.count({ where: { status: "approved" } }) : 1;

    let anyOk = false;
    let transientError = "";
    for (const token of tokens) {
      const locale: Locale = isLocale(token.locale) ? token.locale : isLocale(user.locale) ? user.locale : "en";
      const { title, body } = composePush(kind, params, {
        locale,
        discreet: user.notifyDiscreet,
        count,
      });
      const result = await sendPush({
        token: token.token,
        kind,
        recipientId: user.id,
        targetId: job.targetId,
        title,
        body,
        route: KIND_SPECS[kind].route(job.targetId),
      });
      if (result.ok) {
        anyOk = true;
        await prisma.pushToken
          .update({ where: { id: token.id }, data: { lastSendOkAt: new Date() } })
          .catch(() => {});
      } else if (result.prune) {
        await prisma.pushToken.delete({ where: { id: token.id } }).catch(() => {});
      } else {
        transientError = result.error;
      }
    }

    if (anyOk) {
      await finalize(job.id, { status: "sent", lastError: "" });
    } else if (transientError) {
      const attempts = job.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await finalize(job.id, { status: "failed", lastError: transientError, attempts });
      } else {
        await finalize(job.id, {
          status: "queued",
          lastError: transientError,
          attempts,
          nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
        });
      }
    } else {
      // Every token pruned mid-send: same truth as having none.
      await finalize(job.id, { status: "skipped", lastError: "no-tokens" });
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finalize(job.id, { status: "failed", lastError: message }).catch(() => {});
    return true;
  }
}

/** Hourly retention pass: job rows at 90 d (§11), token rows past FCM's GC. */
async function prune(): Promise<void> {
  const now = Date.now();
  await prisma.notificationJob.deleteMany({
    where: { createdAt: { lt: new Date(now - JOB_RETENTION_MS) } },
  });
  const cutoff = new Date(now - TOKEN_PRUNE_MS);
  await prisma.pushToken.deleteMany({
    where: {
      lastSeenAt: { lt: cutoff },
      OR: [{ lastSendOkAt: null }, { lastSendOkAt: { lt: cutoff } }],
    },
  });
}

export function startNotificationWorker(): { stop(): void } {
  let stopped = false;
  let wake: (() => void) | null = null;
  (globalThis as { __notifyWake?: () => void }).__notifyWake = () => wake?.();

  (async () => {
    let lastPrune = 0;
    while (!stopped) {
      let didWork = false;
      try {
        didWork = await processOne();
        if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
          lastPrune = Date.now();
          await prune().catch((err) => console.error("notification prune failed:", err));
        }
      } catch (err) {
        console.error("notification worker error:", err);
      }
      if (!didWork) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, pollMs());
        });
        wake = null;
      }
    }
  })();

  return {
    stop() {
      stopped = true;
      wake?.();
    },
  };
}
