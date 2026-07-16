import { prisma } from "@/lib/prisma";
import { configValue } from "@/lib/config-file";
import { embeddingSettings } from "./settings";
import type { EmbeddingKind } from "./types";

/**
 * Enqueue helpers (docs/SEARCH_DESIGN.md §5.2). Upsert on
 * (kind, targetId, model): status=queued, attempts=0, generation++,
 * nextAttemptAt per trigger. NEVER blocks or fails the calling route — search
 * is a secondary index; queue write errors are logged and swallowed.
 */

export function draftIdleMs(): number {
  return Number(configValue("EMBEDDING_DRAFT_IDLE_MS") ?? 600_000);
}

async function upsertJob(
  kind: EmbeddingKind,
  targetId: string,
  userId: string,
  delayMs: number,
  priority: 0 | 1 = 0
): Promise<void> {
  const settings = await embeddingSettings();
  if (!settings || !settings.enabled) return;
  const nextAttemptAt = new Date(Date.now() + delayMs);
  await prisma.embeddingJob.upsert({
    where: { kind_targetId_model: { kind, targetId, model: settings.model } },
    create: {
      kind,
      targetId,
      userId,
      model: settings.model,
      status: "queued",
      priority,
      nextAttemptAt,
    },
    update: {
      status: "queued",
      userId,
      attempts: 0,
      generation: { increment: 1 },
      nextAttemptAt,
      // A live event may raise a backfill job's priority, never lower it.
      ...(priority === 0 ? { priority: 0 } : {}),
    },
  });
  // Wake the in-process worker (e2e determinism rests on this, not polling).
  (globalThis as { __embedWake?: () => void }).__embedWake?.();
}

/** Fire-and-forget wrapper: a queue failure must not fail the mutation. */
function safely(p: Promise<void>): void {
  p.catch((err) => console.error("embedding enqueue failed:", err));
}

/** Receipt content changed (upload, image edit, note edit, extraction restamp). */
export function enqueueReceiptEmbedding(receiptId: string, userId: string): void {
  safely(upsertJob("receipt", receiptId, userId, 0));
}

/** Draft-claim content mutated — debounced by the queue's own upsert semantics:
 *  every call pushes nextAttemptAt out by the idle window. */
export function enqueueClaimEmbeddingDebounced(claimId: string, userId: string): void {
  safely(upsertJob("claim", claimId, userId, draftIdleMs()));
}

/** Claim content frozen or status-relevant transition (PDF generated, submit,
 *  regeneration) — index immediately. */
export function enqueueClaimEmbeddingNow(claimId: string, userId: string): void {
  safely(upsertJob("claim", claimId, userId, 0));
}

/** Backfill/rebuild enqueue (priority 1) — used by the sweep. */
export async function enqueueForSweep(
  kind: EmbeddingKind,
  targetId: string,
  userId: string,
  delayMs = 0
): Promise<void> {
  await upsertJob(kind, targetId, userId, delayMs, 1);
}

/** Target deleted: remove its vectors + jobs (call inside the route's
 *  transaction where one exists; the sweep GCs any race survivors). */
export async function deleteEmbeddingsFor(
  kind: EmbeddingKind,
  targetId: string,
  tx: Pick<typeof prisma, "embedding" | "embeddingJob"> = prisma
): Promise<void> {
  await tx.embedding.deleteMany({ where: { kind, targetId } });
  await tx.embeddingJob.deleteMany({ where: { kind, targetId } });
}
