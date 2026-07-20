import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApi, ApiError } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { prisma } from "@/lib/prisma";
import { isAiMock } from "@/lib/config";
import { aiCallReady, annotationPaceMs } from "@/lib/extraction/settings";
import { wakeExtractionWorker } from "@/lib/extraction/queue";

export const runtime = "nodejs";

/**
 * Admin health for the background receipt-annotation queue — the annotation
 * counterpart of the search tab's embedding-queue block. GET reports counts,
 * backlog age, pace, and the receipts the worker terminally gave up on
 * (with their errors); POST re-queues failed jobs (all, or a chosen subset),
 * resetting their attempt budget — the admin's informed override of the
 * "don't re-burn provider calls on an unreadable receipt" guard.
 */

export async function GET() {
  return handleApi(async () => {
    await requireAdmin();
    const [byStatus, oldest, backfillPending, totalReceipts, annotated, failedJobs] =
      await Promise.all([
        prisma.extractionJob.groupBy({ by: ["status"], _count: true }),
        prisma.extractionJob.findFirst({
          where: { status: "queued" },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        }),
        prisma.extractionJob.count({
          where: { priority: 1, status: { in: ["queued", "running"] } },
        }),
        prisma.receipt.count(),
        prisma.receipt.count({ where: { annotatedAt: { not: null } } }),
        prisma.extractionJob.findMany({
          where: { status: "failed" },
          orderBy: { updatedAt: "desc" },
          take: 50,
          select: { receiptId: true, userId: true, attempts: true, lastError: true, updatedAt: true },
        }),
      ]);
    const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count]));

    // Names/owners for the failed list (a deleted receipt's job may linger
    // until the sweep GCs it — surface it by id rather than hiding it).
    const failedReceipts = await prisma.receipt.findMany({
      where: { id: { in: failedJobs.map((j) => j.receiptId) } },
      select: { id: true, originalName: true, user: { select: { email: true } } },
    });
    const byId = new Map(failedReceipts.map((r) => [r.id, r]));

    return NextResponse.json({
      queue: {
        queued: counts.queued ?? 0,
        running: counts.running ?? 0,
        failed: counts.failed ?? 0,
        done: counts.done ?? 0,
        backfillPending,
        oldestQueuedAt: oldest?.createdAt.toISOString() ?? null,
      },
      receipts: { total: totalReceipts, annotated },
      paceMs: annotationPaceMs(),
      ready: aiCallReady(),
      mock: isAiMock(),
      failedJobs: failedJobs.map((j) => ({
        receiptId: j.receiptId,
        originalName: byId.get(j.receiptId)?.originalName ?? null,
        ownerEmail: byId.get(j.receiptId)?.user.email ?? null,
        attempts: j.attempts,
        lastError: j.lastError,
        updatedAt: j.updatedAt.toISOString(),
      })),
    });
  });
}

const RetrySchema = z.object({
  // Absent = retry every failed job.
  receiptIds: z.array(z.string().min(1)).min(1).optional(),
});

export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const adminId = await requireAdmin();
    const parsed = RetrySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) throw new ApiError(400, "Invalid retry request");
    const scope = parsed.data.receiptIds;

    const jobs = await prisma.extractionJob.findMany({
      where: { status: "failed", ...(scope ? { receiptId: { in: scope } } : {}) },
      select: { receiptId: true },
    });
    if (jobs.length > 0) {
      // Same reset an enqueue-upsert performs: fresh attempts, bumped
      // generation (a stale in-flight finalize can never win), due now.
      await prisma.extractionJob.updateMany({
        where: { status: "failed", receiptId: { in: jobs.map((j) => j.receiptId) } },
        data: {
          status: "queued",
          attempts: 0,
          generation: { increment: 1 },
          nextAttemptAt: new Date(),
          leaseExpiresAt: null,
          priority: 0,
          lastError: "",
        },
      });
      wakeExtractionWorker();
      await prisma.auditEvent.create({
        data: {
          userId: adminId,
          action: "retry-annotation",
          detail: JSON.stringify({ receiptIds: jobs.map((j) => j.receiptId) }),
        },
      });
    }
    return NextResponse.json({ ok: true, retried: jobs.length });
  });
}
