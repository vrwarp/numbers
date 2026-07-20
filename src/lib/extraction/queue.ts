import { prisma } from "@/lib/prisma";

/**
 * Enqueue helpers for the background receipt-annotation queue (ExtractionJob).
 * Upsert on receiptId: status=queued, attempts=0, generation++ — a re-enqueue
 * always outranks whatever the worker is doing for that receipt (its finalize
 * is generation-conditional). Like the embedding queue, enqueues NEVER block or
 * fail the calling route: annotation is a convenience the claim flow can redo
 * inline, so queue write errors are logged and swallowed.
 */

async function upsertJob(receiptId: string, userId: string, priority: 0 | 1): Promise<void> {
  await prisma.extractionJob.upsert({
    where: { receiptId },
    create: { receiptId, userId, status: "queued", priority },
    update: {
      status: "queued",
      userId,
      attempts: 0,
      generation: { increment: 1 },
      nextAttemptAt: new Date(),
      leaseExpiresAt: null,
      // A live event may raise a backfill job's priority, never lower it.
      ...(priority === 0 ? { priority: 0 } : {}),
    },
  });
  wakeExtractionWorker();
}

/** Wake the in-process worker (e2e determinism rests on this, not polling). */
export function wakeExtractionWorker(): void {
  (globalThis as { __extractWake?: () => void }).__extractWake?.();
}

/** Fire-and-forget wrapper: a queue failure must not fail the mutation. */
function safely(p: Promise<void>): void {
  p.catch((err) => console.error("annotation enqueue failed:", err));
}

/** New upload, or an image edit invalidated the AI annotation → (re)read it. */
export function enqueueReceiptAnnotation(receiptId: string, userId: string): void {
  safely(upsertJob(receiptId, userId, 0));
}

/** Backfill enqueue (priority 1) — used by the worker's sweep. */
export async function enqueueAnnotationForSweep(receiptId: string, userId: string): Promise<void> {
  await upsertJob(receiptId, userId, 1);
}

/**
 * The receipt's annotation was just written by another path — a human
 * transcription (manual entry) or a claim-time inline extraction — so the
 * queued work is moot. Mark the job done and bump generation so a WORKER RUN
 * already in flight finalizes into a no-op instead of overwriting the newer
 * annotation. Fire-and-forget for the same reason as the enqueues.
 */
export function completeAnnotationJobs(receiptIds: string[]): void {
  if (receiptIds.length === 0) return;
  safely(
    prisma.extractionJob
      .updateMany({
        where: { receiptId: { in: receiptIds } },
        data: {
          status: "done",
          generation: { increment: 1 },
          leaseExpiresAt: null,
          lastError: "",
        },
      })
      .then(() => undefined)
  );
}

/** Receipt deleted: remove its job row (the sweep GCs any race survivors). */
export async function deleteAnnotationJob(receiptId: string): Promise<void> {
  await prisma.extractionJob.deleteMany({ where: { receiptId } });
}
