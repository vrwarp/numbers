import { prisma } from "@/lib/prisma";
import { configValue } from "@/lib/config-file";
import { readStoredFile, previewPagePath } from "@/lib/storage";
import { renderPdfPreviewPages } from "@/lib/pdf/preview";
import { embeddingSettings, modelConfigOf } from "./settings";
import { embedImage, embedText, EmbedError } from "./provider";
import {
  receiptFingerprint,
  receiptPromptText,
  receiptYear,
  buildClaimComposite,
  claimYear,
  sha256Hex,
} from "./content";
import { enqueueForSweep, draftIdleMs } from "./queue";
import { indexCacheUpsert, indexCacheRemove, invalidateIndexCache } from "./index-cache";
import type { EmbeddingKind } from "./types";

/**
 * The background embedding worker (docs/SEARCH_DESIGN.md §5.3-5.4): a
 * singleton loop registered from src/instrumentation.ts. Claims one job at a
 * time (the endpoint is a single GPU), embeds run-time content, and finalizes
 * with a generation-conditional write so an enqueue racing a running embed can
 * never be lost and a stale vector is never persisted.
 */

const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 8;

function pollMs(): number {
  return Number(configValue("EMBEDDING_POLL_MS") ?? 15_000);
}

type ReceiptInput = {
  fingerprint: string;
  userId: string;
  year: number;
  embed: () => Promise<Float32Array>;
};

async function buildReceiptInput(
  receiptId: string,
  cfg: ReturnType<typeof modelConfigOf>
): Promise<ReceiptInput | null> {
  const r = await prisma.receipt.findUnique({ where: { id: receiptId } });
  if (!r) return null;
  // Lazily stamp fileSha256 for pre-feature rows (we read the file anyway).
  let fileSha = r.fileSha256;
  let bytes: Buffer | null = null;
  if (!fileSha) {
    bytes = await readStoredFile(r.filePath);
    fileSha = sha256Hex(bytes);
    await prisma.receipt.update({ where: { id: r.id }, data: { fileSha256: fileSha } });
  }
  const content = { ...r, fileSha256: fileSha };
  const prompt = receiptPromptText(content);
  return {
    fingerprint: receiptFingerprint(content),
    userId: r.userId,
    year: receiptYear(content),
    embed: async () => {
      if (r.mimeType === "application/pdf") {
        // Page-1 raster: reuse the preview cache when the route has built it,
        // else render in memory (the WebP goes through the provider's JPEG
        // normalization either way).
        const page = await readStoredFile(previewPagePath(r.filePath, 1)).catch(
          async () => (await renderPdfPreviewPages(await readStoredFile(r.filePath))).pages[0]
        );
        if (!page) throw new EmbedError("PDF rendered no pages");
        return embedImage(page, prompt, cfg);
      }
      const img = bytes ?? (await readStoredFile(r.filePath));
      return embedImage(img, prompt, cfg);
    },
  };
}

async function buildClaimInput(
  claimId: string,
  cfg: ReturnType<typeof modelConfigOf>
): Promise<ReceiptInput | null> {
  const c = await prisma.reimbursement.findUnique({
    where: { id: claimId },
    include: {
      lineItems: true,
      user: { select: { fullName: true, email: true } },
      receipts: { include: { receipt: { select: { merchant: true } } } },
    },
  });
  if (!c) return null;
  const content = {
    ownerName: c.user.fullName || c.user.email,
    claimDescription: c.claimDescription,
    lineItems: c.lineItems,
    merchants: c.receipts.map((j) => j.receipt.merchant).filter(Boolean),
    totalCents: c.totalCents,
    createdAt: c.createdAt,
    submittedAt: c.submittedAt,
  };
  const composite = buildClaimComposite(content);
  return {
    fingerprint: sha256Hex(composite),
    userId: c.userId,
    year: claimYear(content),
    embed: () => embedText(composite, cfg),
  };
}

async function writeLog(
  userId: string,
  model: string,
  label: string,
  parsed: object,
  durationMs: number,
  error?: string
): Promise<void> {
  // Invariant 7 with the §9 privacy boundary: label + hashes, never content.
  await prisma.extractionLog
    .create({
      data: {
        userId,
        kind: "embedding",
        model,
        prompt: label,
        parsedJson: JSON.stringify(parsed),
        status: error ? "error" : "success",
        errorMessage: error ?? null,
        durationMs,
      },
    })
    .catch(() => {});
}

/** Process one runnable job. Returns false when the queue is idle. */
async function processOne(): Promise<boolean> {
  const settings = await embeddingSettings();
  if (!settings?.enabled) return false;
  const cfg = modelConfigOf(settings);
  const now = new Date();

  // Crash recovery: reclaim expired leases.
  await prisma.embeddingJob.updateMany({
    where: { status: "running", leaseExpiresAt: { lt: now } },
    data: { status: "queued", nextAttemptAt: now, leaseExpiresAt: null },
  });

  const job = await prisma.embeddingJob.findFirst({
    where: { status: "queued", nextAttemptAt: { lte: now }, model: settings.model },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  if (!job) return false;

  const claimed = await prisma.embeddingJob.updateMany({
    where: { id: job.id, status: "queued", generation: job.generation },
    data: { status: "running", leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
  });
  if (claimed.count === 0) return true; // raced; try the next one

  const gen = job.generation;
  const label = `${job.kind} ${job.targetId}`;
  const t0 = Date.now();
  try {
    const input =
      job.kind === "receipt"
        ? await buildReceiptInput(job.targetId, cfg)
        : await buildClaimInput(job.targetId, cfg);

    if (!input) {
      // Target gone: finalize (conditionally) and clean any vector rows.
      await prisma.$transaction([
        prisma.embeddingJob.deleteMany({ where: { id: job.id, generation: gen } }),
        prisma.embedding.deleteMany({ where: { kind: job.kind, targetId: job.targetId } }),
      ]);
      indexCacheRemove(job.kind as EmbeddingKind, job.targetId);
      return true;
    }

    const existing = await prisma.embedding.findUnique({
      where: {
        kind_targetId_model: { kind: job.kind, targetId: job.targetId, model: cfg.model },
      },
      select: { sourceSha256: true },
    });

    let vector: Float32Array | null = null;
    if (existing?.sourceSha256 !== input.fingerprint) {
      vector = await input.embed(); // ~15 s, NO transaction held
    }

    // Finalize — ORDER MATTERS (§5.3): the generation-conditional job update
    // comes FIRST; 0 rows = an enqueue raced us (or the job vanished) → skip
    // the vector write entirely, the follow-up run re-embeds.
    await prisma.$transaction(async (tx) => {
      const done = await tx.embeddingJob.updateMany({
        where: { id: job.id, status: "running", generation: gen },
        data: { status: "done", leaseExpiresAt: null, lastError: "" },
      });
      if (done.count === 0 || !vector) return;
      const target =
        job.kind === "receipt"
          ? await tx.receipt.findUnique({ where: { id: job.targetId }, select: { id: true } })
          : await tx.reimbursement.findUnique({ where: { id: job.targetId }, select: { id: true } });
      if (!target) return; // deleted mid-embed; sweep GCs the job row
      await tx.embedding.upsert({
        where: {
          kind_targetId_model: { kind: job.kind, targetId: job.targetId, model: cfg.model },
        },
        create: {
          kind: job.kind,
          targetId: job.targetId,
          userId: input.userId,
          year: input.year,
          model: cfg.model,
          dim: vector.length,
          vector: new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength)) as Uint8Array<ArrayBuffer>,
          sourceSha256: input.fingerprint,
        },
        update: {
          userId: input.userId,
          year: input.year,
          dim: vector.length,
          vector: new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength)) as Uint8Array<ArrayBuffer>,
          sourceSha256: input.fingerprint,
        },
      });
    });

    if (vector) {
      indexCacheUpsert(
        {
          kind: job.kind as EmbeddingKind,
          targetId: job.targetId,
          userId: input.userId,
          year: input.year,
          vector,
        },
        cfg.model
      );
      await writeLog(
        input.userId,
        cfg.model,
        label,
        { dim: vector.length, targetKind: job.kind, targetId: job.targetId,
          promptSha256: input.fingerprint, promptChars: 0 },
        Date.now() - t0
      );
    }
    return true;
  } catch (err) {
    const message = err instanceof EmbedError ? err.message : String(err);
    const failed = job.attempts + 1 >= MAX_ATTEMPTS;
    const backoff = Math.min(30_000 * 2 ** (job.attempts + 1), 3_600_000);
    // Recompute the fingerprint cheaply for failedSourceSha256 (may differ from
    // input if the build itself failed — fall back to empty).
    await prisma.embeddingJob
      .updateMany({
        where: { id: job.id, status: "running", generation: gen },
        data: failed
          ? {
              status: "failed",
              attempts: job.attempts + 1,
              lastError: message.slice(0, 500),
              leaseExpiresAt: null,
              failedSourceSha256: await currentFingerprint(job.kind as EmbeddingKind, job.targetId),
            }
          : {
              status: "queued",
              attempts: job.attempts + 1,
              lastError: message.slice(0, 500),
              leaseExpiresAt: null,
              nextAttemptAt: new Date(Date.now() + backoff),
            },
      })
      .catch(() => {});
    const owner = await prisma.embeddingJob
      .findUnique({ where: { id: job.id }, select: { userId: true } })
      .catch(() => null);
    await writeLog(owner?.userId ?? "unknown", cfg.model, label, {
      targetKind: job.kind,
      targetId: job.targetId,
    }, Date.now() - t0, message.slice(0, 500));
    return true;
  }
}

async function currentFingerprint(kind: EmbeddingKind, targetId: string): Promise<string> {
  try {
    if (kind === "receipt") {
      const r = await prisma.receipt.findUnique({ where: { id: targetId } });
      return r ? receiptFingerprint(r) : "";
    }
    const c = await prisma.reimbursement.findUnique({
      where: { id: targetId },
      include: {
        lineItems: true,
        user: { select: { fullName: true, email: true } },
        receipts: { include: { receipt: { select: { merchant: true } } } },
      },
    });
    if (!c) return "";
    return sha256Hex(
      buildClaimComposite({
        ownerName: c.user.fullName || c.user.email,
        claimDescription: c.claimDescription,
        lineItems: c.lineItems,
        merchants: c.receipts.map((j) => j.receipt.merchant).filter(Boolean),
        totalCents: c.totalCents,
        createdAt: c.createdAt,
        submittedAt: c.submittedAt,
      })
    );
  } catch {
    return "";
  }
}

/**
 * Backfill / reconcile / GC sweep (§5.4): pure-DB staleness checks, priority-1
 * enqueues, orphan cleanup. Idempotent; runs at worker start, daily, and
 * synchronously from the admin reset/rebuild handlers (kickSweep).
 */
export async function runSweep(force = false): Promise<{ enqueued: number }> {
  const settings = await embeddingSettings();
  if (!settings?.enabled) return { enqueued: 0 };
  const model = settings.model;
  let enqueued = 0;

  // GC: wrong-model rows (interrupted model change) + targetless rows/jobs.
  await prisma.embedding.deleteMany({ where: { model: { not: model } } });
  await prisma.embeddingJob.deleteMany({ where: { model: { not: model } } });
  const [receiptIds, claimIds] = await Promise.all([
    prisma.receipt.findMany({ select: { id: true } }),
    prisma.reimbursement.findMany({ select: { id: true } }),
  ]);
  const liveReceipts = new Set(receiptIds.map((r) => r.id));
  const liveClaims = new Set(claimIds.map((c) => c.id));
  const isOrphan = (r: { kind: string; targetId: string }) =>
    r.kind === "receipt" ? !liveReceipts.has(r.targetId) : !liveClaims.has(r.targetId);
  const embRows = await prisma.embedding.findMany({
    select: { id: true, kind: true, targetId: true },
  });
  const embOrphans = embRows.filter(isOrphan).map((r) => r.id);
  if (embOrphans.length)
    await prisma.embedding.deleteMany({ where: { id: { in: embOrphans } } });
  const jobRows = await prisma.embeddingJob.findMany({
    select: { id: true, kind: true, targetId: true },
  });
  const jobOrphans = jobRows.filter(isOrphan).map((r) => r.id);
  if (jobOrphans.length)
    await prisma.embeddingJob.deleteMany({ where: { id: { in: jobOrphans } } });

  const embeddings = await prisma.embedding.findMany({
    where: { model },
    select: { kind: true, targetId: true, sourceSha256: true },
  });
  const bySha = new Map(embeddings.map((e) => [`${e.kind}:${e.targetId}`, e.sourceSha256]));
  const jobs = await prisma.embeddingJob.findMany({
    select: { kind: true, targetId: true, status: true, failedSourceSha256: true },
  });
  const jobState = new Map(jobs.map((j) => [`${j.kind}:${j.targetId}`, j]));

  // Receipts: fingerprint from DB columns only (fileSha256 may be "" on
  // pre-feature rows — they enqueue once; the embed stamps it).
  const receipts = await prisma.receipt.findMany();
  for (const r of receipts) {
    const fp = receiptFingerprint(r);
    const k = `receipt:${r.id}`;
    const existing = jobState.get(k);
    if (existing?.status === "queued" || existing?.status === "running") continue;
    if (existing?.status === "failed" && existing.failedSourceSha256 === fp && !force) continue;
    if (!force && bySha.get(k) === fp) continue;
    await enqueueForSweep("receipt", r.id, r.userId);
    enqueued++;
  }

  // Claims: drafts only when idle ≥ the debounce window.
  const idleCutoff = new Date(Date.now() - draftIdleMs());
  const claims = await prisma.reimbursement.findMany({
    include: {
      lineItems: true,
      user: { select: { fullName: true, email: true } },
      receipts: { include: { receipt: { select: { merchant: true } } } },
    },
  });
  for (const c of claims) {
    if (c.status === "draft" && c.updatedAt > idleCutoff) continue;
    const fp = sha256Hex(
      buildClaimComposite({
        ownerName: c.user.fullName || c.user.email,
        claimDescription: c.claimDescription,
        lineItems: c.lineItems,
        merchants: c.receipts.map((j) => j.receipt.merchant).filter(Boolean),
        totalCents: c.totalCents,
        createdAt: c.createdAt,
        submittedAt: c.submittedAt,
      })
    );
    const k = `claim:${c.id}`;
    const existing = jobState.get(k);
    if (existing?.status === "queued" || existing?.status === "running") continue;
    if (existing?.status === "failed" && existing.failedSourceSha256 === fp && !force) continue;
    if (!force && bySha.get(k) === fp) continue;
    await enqueueForSweep("claim", c.id, c.userId);
    enqueued++;
  }

  invalidateIndexCache(); // GC may have removed rows
  return { enqueued };
}

export type EmbeddingWorkerHandle = { stop(): void; kick(): void };

export function startEmbeddingWorker(): EmbeddingWorkerHandle {
  let stopped = false;
  let wake: (() => void) | null = null;
  let sweptAt = 0;

  (globalThis as { __embedWake?: () => void }).__embedWake = () => wake?.();

  (async () => {
    // Give the server a moment to finish booting before the first sweep.
    await new Promise((r) => setTimeout(r, 3000));
    while (!stopped) {
      try {
        if (Date.now() - sweptAt > 24 * 3_600_000) {
          sweptAt = Date.now();
          await runSweep();
        }
        const didWork = await processOne();
        if (didWork) continue;
      } catch (err) {
        console.error("embedding worker:", err);
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, pollMs());
      });
      wake = null;
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

/** Synchronous sweep entry for the admin reset/rebuild handlers (§3.3). */
export async function kickSweep(force = false): Promise<{ enqueued: number }> {
  const result = await runSweep(force);
  (globalThis as { __embedWake?: () => void }).__embedWake?.();
  return result;
}
