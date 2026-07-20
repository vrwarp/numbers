import { prisma } from "@/lib/prisma";
import type { NotificationKind, NotificationParams } from "./catalog";
import { KIND_SPECS } from "./catalog";

/**
 * Notification enqueue helpers (docs/NOTIFICATIONS_DESIGN.md §7.1). Rows are
 * created UNCONDITIONALLY of push preferences — the job row is the event
 * record feeding the in-app activity list (§5 parity); whether it is
 * DELIVERED is decided at send time (§7.3). Fire-and-forget from mutation
 * routes: a queue failure must never fail the mutation (invariant 11
 * discipline). dedupeKey (unique) makes reconcile replays and route retries
 * no-ops (§7.2).
 */

type EnqueueOpts = {
  /** When the event actually happened; defaults to now. Reconcile-sourced
   *  events pass the mirror timestamp so the §7.3 age gate sees the truth. */
  occurredAt?: Date;
  /** §7.1: reconcile-sourced events are inherently late — suppress a
   *  recipient who IS the reconciling user (they are reading the outcome on
   *  screen right now). */
  reconcilerId?: string;
};

type ClaimEventInput = {
  id: string;
  userId: string;
  submitSeq: number;
  /** claimEvent only — NEVER claimDescription (§9.1 lock-screen rule). */
  claimEvent: string;
  approverUserId?: string | null;
};

function params(occurredAt: Date | undefined, label: string, name?: string): NotificationParams {
  return {
    occurredAt: (occurredAt ?? new Date()).toISOString(),
    ...(label.trim() ? { label: label.trim() } : {}),
    ...(name?.trim() ? { name: name.trim() } : {}),
  };
}

async function createJob(
  kind: NotificationKind,
  recipientId: string,
  targetId: string,
  dedupeKey: string,
  payload: NotificationParams
): Promise<void> {
  try {
    await prisma.notificationJob.create({
      data: {
        userId: recipientId,
        kind,
        category: KIND_SPECS[kind].category,
        targetId,
        dedupeKey,
        payloadJson: JSON.stringify(payload),
      },
    });
  } catch (err) {
    // Unique violation on dedupeKey = replay (reconcile, route retry) → no-op.
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
      return;
    }
    throw err;
  }
  (globalThis as { __notifyWake?: () => void }).__notifyWake?.();
}

/** Fire-and-forget wrapper (the embeddings-queue discipline). */
function safely(p: Promise<void>): void {
  p.catch((err) => console.error("notification enqueue failed:", err));
}

function claimDedupe(kind: NotificationKind, claim: ClaimEventInput, recipientId: string): string {
  return `${kind}:${claim.id}:${recipientId}:${claim.submitSeq}`;
}

/** SUBMIT landed (submit route, or reconcile): tell the named approver. */
export function notifySigningRequest(
  claim: ClaimEventInput,
  actorId: string,
  opts: EnqueueOpts = {}
): void {
  const approver = claim.approverUserId;
  if (!approver || approver === opts.reconcilerId) return;
  safely(
    (async () => {
      const actor = await prisma.user.findUnique({
        where: { id: actorId },
        select: { fullName: true, email: true },
      });
      await createJob(
        "signing-request",
        approver,
        claim.id,
        claimDedupe("signing-request", claim, approver),
        params(opts.occurredAt, claim.claimEvent, actor?.fullName || actor?.email || "")
      );
    })()
  );
}

/** APPROVE/REJECT landed: tell the owner; on approve, fan out to the finance
 *  duty (all unpaused treasurers/admins, minus the actor). */
export function notifyDecision(
  claim: ClaimEventInput,
  decision: "approved" | "rejected",
  actorId: string,
  opts: EnqueueOpts = {}
): void {
  const kind: NotificationKind = decision === "approved" ? "claim-approved" : "claim-rejected";
  if (claim.userId !== actorId && claim.userId !== opts.reconcilerId) {
    safely(
      createJob(
        kind,
        claim.userId,
        claim.id,
        claimDedupe(kind, claim, claim.userId),
        params(opts.occurredAt, claim.claimEvent)
      )
    );
  }
  if (decision !== "approved") return;
  safely(
    (async () => {
      const financeDuty = await prisma.user.findMany({
        where: { role: { in: ["treasurer", "admin"] }, financePaused: false },
        select: { id: true },
      });
      for (const { id } of financeDuty) {
        if (id === actorId || id === opts.reconcilerId) continue;
        await createJob(
          "finance-queue",
          id,
          claim.id,
          claimDedupe("finance-queue", claim, id),
          params(opts.occurredAt, claim.claimEvent)
        );
      }
    })()
  );
}

/** MARK_PAID landed: tell the owner (skip a treasurer paying their own claim). */
export function notifyPaid(claim: ClaimEventInput, actorId: string, opts: EnqueueOpts = {}): void {
  if (claim.userId === actorId || claim.userId === opts.reconcilerId) return;
  safely(
    createJob(
      "claim-paid",
      claim.userId,
      claim.id,
      claimDedupe("claim-paid", claim, claim.userId),
      params(opts.occurredAt, claim.claimEvent)
    )
  );
}

/** §7.1b device-request hint: server-derived dedupe bucket (15 min) — no
 *  client-supplied id ever reaches the push path (excludeTokenId is OUR row
 *  id, resolved by the route). AWAITED by its route (the route itself is
 *  fire-and-forget from the ceremony's viewpoint). */
export async function enqueueDeviceRequest(userId: string, excludeTokenId?: string): Promise<void> {
  const bucket = Math.floor(Date.now() / (15 * 60_000));
  await createJob("device-request", userId, userId, `device-request:${userId}:${bucket}`, {
    occurredAt: new Date().toISOString(),
    ...(excludeTokenId ? { excludeTokenId } : {}),
  });
}

/** §8.7 self-test: an ordinary catalog enqueue so it exercises the real
 *  worker end-to-end. 30 s bucket = a light natural rate limit. */
export async function enqueueSelfTest(userId: string): Promise<void> {
  const bucket = Math.floor(Date.now() / 30_000);
  await createJob("self-test", userId, userId, `self-test:${userId}:${bucket}`, {
    occurredAt: new Date().toISOString(),
  });
}
