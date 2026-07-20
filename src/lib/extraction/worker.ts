import { prisma } from "@/lib/prisma";
import { quotaCooldownMs } from "@/lib/config";
import { extractReceipt, ExtractionError, type ExtractionMeta } from "@/lib/ai/extract";
import { isQuotaErrorMessage } from "@/lib/ai/throttle";
import { parseDollarsToCents } from "@/lib/money";
import { enqueueReceiptEmbedding } from "@/lib/embeddings/queue";
import { enqueueAnnotationForSweep } from "./queue";
import { aiCallReady, annotationPaceMs, extractionPollMs } from "./settings";
import { annotationRetryPlan, paceWaitMs } from "./retry";

/**
 * The background receipt-annotation worker: a singleton loop registered from
 * src/instrumentation.ts that drains the ExtractionJob queue at a deliberate
 * drip — at most one receipt per EXTRACTION_PACE_MS (default one per minute) —
 * so the provider's request budget stays available for user-initiated calls.
 * Each job runs the SAME per-receipt extraction as claim creation and stamps
 * the result onto the Receipt row (merchant, purchaseDate, printed totals,
 * summary, annotatedAt), where claim creation later consumes it without an AI
 * call. Crash/race safety mirrors the embedding worker: 5-minute leases and a
 * generation-conditional finalize, so a re-enqueue (image edit) or a
 * supersede (manual entry, inline claim extraction) can never be clobbered by
 * a slower in-flight run.
 */

const LEASE_MS = 5 * 60_000;

/** Every provider call is telemetry-logged (invariant 7), claim-linked later
 *  if a claim consumes the annotation (ExtractionLog.receiptId adoption). */
async function writeLog(
  userId: string,
  receiptId: string,
  meta: ExtractionMeta,
  parsedJson: string | null,
  error: string | null
): Promise<void> {
  await prisma.extractionLog
    .create({
      data: {
        userId,
        kind: "receipt",
        receiptId,
        model: meta.model,
        prompt: meta.prompt,
        receiptsJson: meta.receiptsJson,
        rawResponse: meta.rawResponse,
        parsedJson,
        status: error ? "error" : "success",
        errorMessage: error,
        durationMs: meta.durationMs,
      },
    })
    .catch(() => {});
}

/** Process one runnable job. "idle" = nothing to do; "worked" = handled
 *  without a provider call; "called" = made a provider call (paces the drip). */
async function processOne(): Promise<"idle" | "worked" | "called"> {
  if (!aiCallReady()) return "idle";
  const now = new Date();

  // Crash recovery: reclaim expired leases.
  await prisma.extractionJob.updateMany({
    where: { status: "running", leaseExpiresAt: { lt: now } },
    data: { status: "queued", nextAttemptAt: now, leaseExpiresAt: null },
  });

  const job = await prisma.extractionJob.findFirst({
    where: { status: "queued", nextAttemptAt: { lte: now } },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  if (!job) return "idle";

  const claimed = await prisma.extractionJob.updateMany({
    where: { id: job.id, status: "queued", generation: job.generation },
    data: { status: "running", leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
  });
  if (claimed.count === 0) return "worked"; // raced; try the next one

  const gen = job.generation;
  const receipt = await prisma.receipt.findUnique({ where: { id: job.receiptId } });

  if (!receipt) {
    // Receipt gone: drop the job (conditionally — a re-create can't happen,
    // but keep the generation discipline uniform).
    await prisma.extractionJob.deleteMany({ where: { id: job.id, generation: gen } });
    return "worked";
  }

  if (receipt.annotatedAt) {
    // Another path (manual entry, inline claim extraction) annotated it while
    // this job sat queued — nothing to read; keep the newer annotation.
    await prisma.extractionJob.updateMany({
      where: { id: job.id, status: "running", generation: gen },
      data: { status: "done", leaseExpiresAt: null, lastError: "" },
    });
    return "worked";
  }

  try {
    // The queue reschedule is the quota retry — surface a 429 immediately
    // rather than sleeping out cooldowns while holding the lease.
    const { result, meta } = await extractReceipt(
      {
        id: receipt.id,
        filePath: receipt.filePath,
        mimeType: receipt.mimeType,
        originalName: receipt.originalName,
      },
      undefined,
      { quotaMaxRetries: 0 }
    );

    // Finalize — ORDER MATTERS (the embedding worker's rule): the
    // generation-conditional job update comes FIRST; 0 rows = a re-enqueue or
    // supersede raced us → skip the receipt stamp entirely, the newer intent
    // owns the row.
    let stamped = false;
    await prisma.$transaction(async (tx) => {
      const done = await tx.extractionJob.updateMany({
        where: { id: job.id, status: "running", generation: gen },
        data: { status: "done", leaseExpiresAt: null, lastError: "" },
      });
      if (done.count === 0) return;
      const current = await tx.receipt.findUnique({ where: { id: receipt.id } });
      if (!current) return; // deleted mid-call; sweep GCs the job row
      // A human transcription or a fresher annotation landed mid-call — never
      // overwrite it with this (older) read.
      if (current.annotatedAt) return;
      stamped = true;
      await tx.receipt.update({
        where: { id: receipt.id },
        data: {
          merchant: result.merchant,
          purchaseDate: result.purchaseDate ?? "",
          extractedTotalCents: parseDollarsToCents(result.totalAmount),
          extractedRefundCents: parseDollarsToCents(result.refundAmount),
          extractedSummary: result.summary,
          annotatedAt: new Date(),
          annotationSource: "ai",
        },
      });
    });

    // The call happened — log it either way (invariant 7).
    await writeLog(receipt.userId, receipt.id, meta, JSON.stringify(result), null);
    // Merchant/purchaseDate are embedded content → re-index (invariant 11).
    if (stamped) enqueueReceiptEmbedding(receipt.id, receipt.userId);
    return "called";
  } catch (err) {
    const meta: ExtractionMeta =
      err instanceof ExtractionError
        ? err.meta
        : {
            model: "unknown",
            prompt: "",
            receiptsJson: JSON.stringify([
              { id: receipt.id, name: receipt.originalName, mimeType: receipt.mimeType },
            ]),
            rawResponse: null,
            durationMs: 0,
          };
    const message = err instanceof Error ? err.message : "annotation failed";
    const plan = annotationRetryPlan({
      attempts: job.attempts,
      isQuota: isQuotaErrorMessage(message) || isQuotaErrorMessage(meta.rawResponse),
      quotaCooldownMs: quotaCooldownMs(),
      now: Date.now(),
    });
    await prisma.extractionJob
      .updateMany({
        where: { id: job.id, status: "running", generation: gen },
        data:
          plan.kind === "failed"
            ? {
                status: "failed",
                attempts: plan.attempts,
                lastError: message.slice(0, 500),
                leaseExpiresAt: null,
                failedFileSha256: receipt.fileSha256,
              }
            : {
                status: "queued",
                attempts: plan.attempts,
                lastError: message.slice(0, 500),
                leaseExpiresAt: null,
                nextAttemptAt: plan.nextAttemptAt,
              },
      })
      .catch(() => {});
    await writeLog(receipt.userId, receipt.id, meta, null, message.slice(0, 500));
    return "called";
  }
}

/**
 * Backfill / GC sweep: pure-DB checks, priority-1 enqueues. Never-annotated
 * receipts (legacy rows predating the worker, or rows whose job vanished) get
 * queued behind live uploads; terminally failed receipts are retried only when
 * their file bytes changed. Idempotent; runs at worker start and daily.
 */
export async function runAnnotationSweep(): Promise<{ enqueued: number }> {
  const [jobs, receipts] = await Promise.all([
    prisma.extractionJob.findMany({
      select: { id: true, receiptId: true, status: true, failedFileSha256: true },
    }),
    prisma.receipt.findMany({
      select: { id: true, userId: true, fileSha256: true, annotatedAt: true },
      // Newest first: fresher receipts are likelier to be claimed soon.
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const live = new Set(receipts.map((r) => r.id));
  const orphans = jobs.filter((j) => !live.has(j.receiptId)).map((j) => j.id);
  if (orphans.length > 0) {
    await prisma.extractionJob.deleteMany({ where: { id: { in: orphans } } });
  }

  const jobByReceipt = new Map(jobs.map((j) => [j.receiptId, j]));
  let enqueued = 0;
  for (const r of receipts) {
    if (r.annotatedAt) continue;
    const job = jobByReceipt.get(r.id);
    if (job?.status === "queued" || job?.status === "running") continue;
    if (job?.status === "failed" && job.failedFileSha256 === r.fileSha256) continue;
    await enqueueAnnotationForSweep(r.id, r.userId);
    enqueued++;
  }
  return { enqueued };
}

export type ExtractionWorkerHandle = { stop(): void; kick(): void };

export function startExtractionWorker(): ExtractionWorkerHandle {
  let stopped = false;
  let wake: (() => void) | null = null;
  let sweptAt = 0;
  let lastCallAt = 0;

  (globalThis as { __extractWake?: () => void }).__extractWake = () => wake?.();

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, ms);
    }).finally(() => {
      wake = null;
    });

  (async () => {
    // Give the server a moment to finish booting before the first sweep.
    await new Promise((r) => setTimeout(r, 3000));
    while (!stopped) {
      try {
        if (Date.now() - sweptAt > 24 * 3_600_000) {
          sweptAt = Date.now();
          await runAnnotationSweep();
        }
        // The drip: hold off while the pace window from the previous provider
        // call is still open. Sleeping in poll-sized chunks keeps the wait
        // responsive to config changes and stop(); an early wake loops back
        // here and keeps waiting — the pace is a hard cap, not a hint.
        const wait = paceWaitMs(lastCallAt, Date.now(), annotationPaceMs());
        if (wait > 0) {
          await sleep(Math.min(wait, extractionPollMs()));
          continue;
        }
        const outcome = await processOne();
        if (outcome === "called") lastCallAt = Date.now();
        if (outcome !== "idle") continue;
      } catch (err) {
        console.error("annotation worker:", err);
      }
      await sleep(extractionPollMs());
    }
  })();

  return {
    stop() {
      stopped = true;
      wake?.();
    },
    kick() {
      wake?.();
    },
  };
}
