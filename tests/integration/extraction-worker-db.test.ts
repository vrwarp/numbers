import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { freshTestDb, removeTestDb } from "./db";

/**
 * DB-backed coverage of the background annotation worker's crash/race safety
 * (src/lib/extraction/worker.ts): lease reclaim, the generation-conditional
 * finalize (a supersede mid-call must never be clobbered), the retry plan on
 * failures, and the backfill/GC sweep. `processOne` is driven directly — the
 * live loop's pacing is covered by unit retry tests + the e2e worker spec.
 */

const { dir } = freshTestDb("extraction");
process.env.AI_MOCK = "1";

type Prisma = typeof import("@/lib/prisma")["prisma"];
let prisma: Prisma;
let worker: typeof import("@/lib/extraction/worker");
let queue: typeof import("@/lib/extraction/queue");
let userId: string;

/** Hook the mocked extractReceipt calls back into each test ("simulate what
 *  happens WHILE the provider call is in flight"). Null = behave like AI_MOCK. */
let midCall: ((receiptId: string) => Promise<void>) | null = null;

vi.doMock("@/lib/ai/extract", async () => {
  const real = await vi.importActual<typeof import("@/lib/ai/extract")>("@/lib/ai/extract");
  return {
    ...real,
    extractReceipt: async (
      receipt: Parameters<typeof real.extractReceipt>[0],
      onEvent?: Parameters<typeof real.extractReceipt>[1],
      opts?: Parameters<typeof real.extractReceipt>[2]
    ) => {
      if (midCall) await midCall(receipt.id);
      return real.extractReceipt(receipt, onEvent, opts);
    },
  };
});

async function makeReceipt(name: string, extra: Record<string, unknown> = {}) {
  return prisma.receipt.create({
    data: {
      userId,
      filePath: `uploads/${userId}/${name}`,
      mimeType: "image/webp",
      originalName: name,
      sizeBytes: 1000,
      fileSha256: `sha-${name}`,
      ...extra,
    },
  });
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  worker = await import("@/lib/extraction/worker");
  queue = await import("@/lib/extraction/queue");
  const user = await prisma.user.create({ data: { email: "worker-int@example.com" } });
  userId = user.id;
  // AI_MOCK skips file reads, but keep the tree present for realism.
  fs.mkdirSync(path.join(dir, "uploads", userId), { recursive: true });
});

beforeEach(async () => {
  midCall = null;
  await prisma.extractionJob.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
  removeTestDb(dir);
});

describe("processOne", () => {
  it("annotates a queued receipt, completes the job, and logs the call", async () => {
    const r = await makeReceipt("normal.jpg");
    await prisma.extractionJob.create({ data: { receiptId: r.id, userId } });

    expect(await worker.processOne()).toBe("called");

    const receipt = await prisma.receipt.findUnique({ where: { id: r.id } });
    expect(receipt?.merchant).toBe("Costco Wholesale");
    expect(receipt?.extractedTotalCents).toBe(10210);
    expect(receipt?.annotatedAt).not.toBeNull();
    expect(receipt?.annotationSource).toBe("ai");

    const job = await prisma.extractionJob.findUnique({ where: { receiptId: r.id } });
    expect(job?.status).toBe("done");
    expect(job?.leaseExpiresAt).toBeNull();

    const log = await prisma.extractionLog.findFirst({ where: { receiptId: r.id } });
    expect(log?.status).toBe("success");
    expect(log?.reimbursementId).toBeNull(); // unlinked until a claim adopts it

    expect(await worker.processOne()).toBe("idle"); // queue drained
  });

  it("reclaims an expired running lease and processes the job", async () => {
    const r = await makeReceipt("leased.jpg");
    await prisma.extractionJob.create({
      data: {
        receiptId: r.id,
        userId,
        status: "running",
        leaseExpiresAt: new Date(Date.now() - 60_000), // crashed holder
      },
    });
    expect(await worker.processOne()).toBe("called");
    const job = await prisma.extractionJob.findUnique({ where: { receiptId: r.id } });
    expect(job?.status).toBe("done");
  });

  it("never clobbers a supersede that lands mid-call (generation-conditional finalize)", async () => {
    const r = await makeReceipt("raced.jpg");
    await prisma.extractionJob.create({ data: { receiptId: r.id, userId } });

    // While the provider call is in flight, a manual entry supersedes: the
    // receipt gains a HUMAN annotation and the job generation moves on.
    midCall = async (receiptId) => {
      await prisma.receipt.update({
        where: { id: receiptId },
        data: {
          merchant: "Typed By Human",
          extractedTotalCents: 4200,
          annotatedAt: new Date(),
          annotationSource: "manual",
        },
      });
      await prisma.extractionJob.update({
        where: { receiptId },
        data: { generation: { increment: 1 }, status: "done" },
      });
    };

    await worker.processOne();

    // The older AI read must NOT overwrite the human transcription.
    const receipt = await prisma.receipt.findUnique({ where: { id: r.id } });
    expect(receipt?.merchant).toBe("Typed By Human");
    expect(receipt?.annotationSource).toBe("manual");
    expect(receipt?.extractedTotalCents).toBe(4200);
  });

  it("skips the receipt stamp when only the annotation raced in (same generation)", async () => {
    const r = await makeReceipt("stamp-raced.jpg");
    await prisma.extractionJob.create({ data: { receiptId: r.id, userId } });
    midCall = async (receiptId) => {
      // Inline claim extraction annotated the receipt but the job row is
      // untouched: finalize marks the job done yet must keep the newer stamp.
      await prisma.receipt.update({
        where: { id: receiptId },
        data: { merchant: "Inline Winner", annotatedAt: new Date(), annotationSource: "ai" },
      });
    };
    await worker.processOne();
    const receipt = await prisma.receipt.findUnique({ where: { id: r.id } });
    expect(receipt?.merchant).toBe("Inline Winner");
    const job = await prisma.extractionJob.findUnique({ where: { receiptId: r.id } });
    expect(job?.status).toBe("done");
  });

  it("completes without a provider call when the receipt was annotated while queued", async () => {
    const r = await makeReceipt("pre-annotated.jpg", {
      merchant: "Already Read",
      annotatedAt: new Date(),
      annotationSource: "manual",
    });
    await prisma.extractionJob.create({ data: { receiptId: r.id, userId } });
    expect(await worker.processOne()).toBe("worked");
    const job = await prisma.extractionJob.findUnique({ where: { receiptId: r.id } });
    expect(job?.status).toBe("done");
    expect(await prisma.extractionLog.count({ where: { receiptId: r.id } })).toBe(0);
  });

  it("drops the job when the receipt is gone", async () => {
    await prisma.extractionJob.create({ data: { receiptId: "ghost-receipt", userId } });
    expect(await worker.processOne()).toBe("worked");
    expect(await prisma.extractionJob.count({ where: { receiptId: "ghost-receipt" } })).toBe(0);
  });

  it("failure backs off with attempts+1 and terminal-fails at 5, remembering the file sha", async () => {
    const r = await makeReceipt("unreadable.jpg"); // mock throws for this name
    await prisma.extractionJob.create({ data: { receiptId: r.id, userId } });

    await worker.processOne();
    let job = await prisma.extractionJob.findUnique({ where: { receiptId: r.id } });
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toContain("could not be read");
    expect(job?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // The failed call is still telemetry-logged.
    const log = await prisma.extractionLog.findFirst({ where: { receiptId: r.id } });
    expect(log?.status).toBe("error");

    await prisma.extractionJob.update({
      where: { receiptId: r.id },
      data: { attempts: 4, nextAttemptAt: new Date(0) },
    });
    await worker.processOne();
    job = await prisma.extractionJob.findUnique({ where: { receiptId: r.id } });
    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(5);
    expect(job?.failedFileSha256).toBe("sha-unreadable.jpg");
  });
});

describe("runAnnotationSweep", () => {
  it("GCs orphan jobs, backfills never-annotated receipts, and respects failed-sha guards", async () => {
    // The sweep scans the whole Receipt table — start it from a clean slate.
    await prisma.receipt.deleteMany();
    await prisma.extractionJob.create({ data: { receiptId: "orphan", userId } });
    const fresh = await makeReceipt("sweep-fresh.jpg");
    const annotated = await makeReceipt("sweep-annotated.jpg", {
      annotatedAt: new Date(),
      annotationSource: "ai",
    });
    const failedSame = await makeReceipt("sweep-failed-same.jpg");
    await prisma.extractionJob.create({
      data: {
        receiptId: failedSame.id,
        userId,
        status: "failed",
        failedFileSha256: "sha-sweep-failed-same.jpg", // unchanged bytes
      },
    });
    const failedChanged = await makeReceipt("sweep-failed-changed.jpg");
    await prisma.extractionJob.create({
      data: {
        receiptId: failedChanged.id,
        userId,
        status: "failed",
        failedFileSha256: "sha-of-the-OLD-bytes",
      },
    });

    const { enqueued } = await worker.runAnnotationSweep();
    expect(enqueued).toBe(2); // fresh + failedChanged

    expect(await prisma.extractionJob.count({ where: { receiptId: "orphan" } })).toBe(0);
    const freshJob = await prisma.extractionJob.findUnique({ where: { receiptId: fresh.id } });
    expect(freshJob?.status).toBe("queued");
    expect(freshJob?.priority).toBe(1); // backfill drains after live uploads
    expect(
      await prisma.extractionJob.count({ where: { receiptId: annotated.id } })
    ).toBe(0);
    const same = await prisma.extractionJob.findUnique({ where: { receiptId: failedSame.id } });
    expect(same?.status).toBe("failed"); // must not re-burn provider calls
    const changed = await prisma.extractionJob.findUnique({
      where: { receiptId: failedChanged.id },
    });
    expect(changed?.status).toBe("queued");
    expect(changed?.attempts).toBe(0);

    // Idempotent: a second sweep enqueues nothing new.
    expect((await worker.runAnnotationSweep()).enqueued).toBe(0);
  });
});

describe("queue upserts", () => {
  it("re-enqueue resets attempts, bumps generation, and re-raises priority only upward", async () => {
    const r = await makeReceipt("upsert.jpg");
    queue.enqueueAnnotationForSweep(r.id, userId);
    await vi.waitFor(async () => {
      expect(await prisma.extractionJob.count({ where: { receiptId: r.id } })).toBe(1);
    });
    let job = await prisma.extractionJob.findUnique({ where: { receiptId: r.id } });
    expect(job?.priority).toBe(1);

    await prisma.extractionJob.update({
      where: { receiptId: r.id },
      data: { status: "failed", attempts: 5 },
    });
    queue.enqueueReceiptAnnotation(r.id, userId); // live event outranks backfill
    await vi.waitFor(async () => {
      const j = await prisma.extractionJob.findUnique({ where: { receiptId: r.id } });
      expect(j?.status).toBe("queued");
    });
    job = await prisma.extractionJob.findUnique({ where: { receiptId: r.id } });
    expect(job?.attempts).toBe(0);
    expect(job?.generation).toBe(1);
    expect(job?.priority).toBe(0);
  });
});
