import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApi, ApiError } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const BodySchema = z.union([
  z.object({ jobId: z.string() }),
  z.object({ all: z.literal(true) }),
]);

/** Retry failed embedding jobs (one or all). Audited (§9). */
export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const adminId = await requireAdmin();
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid retry request");
    const where =
      "jobId" in parsed.data
        ? { id: parsed.data.jobId, status: "failed" }
        : { status: "failed" };
    const result = await prisma.embeddingJob.updateMany({
      where,
      data: {
        status: "queued",
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: "",
        failedSourceSha256: "",
        generation: { increment: 1 },
      },
    });
    (globalThis as { __embedWake?: () => void }).__embedWake?.();
    await prisma.auditEvent.create({
      data: {
        userId: adminId,
        action: "retry-embedding",
        detail: JSON.stringify(
          "jobId" in parsed.data ? { jobId: parsed.data.jobId } : { all: true, count: result.count }
        ),
      },
    });
    return NextResponse.json({ ok: true, retried: result.count });
  });
}
