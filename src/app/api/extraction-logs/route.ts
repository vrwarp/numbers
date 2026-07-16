import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi } from "@/lib/api";

export const runtime = "nodejs";

/**
 * List the caller's AI extraction logs (newest first). ?reimbursementId=
 * filters to one claim. Summaries only — fetch /api/extraction-logs/:id for
 * the full prompt/response and the human-correction diff.
 */
export async function GET(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const reimbursementId = req.nextUrl.searchParams.get("reimbursementId") ?? undefined;
    const logs = await prisma.extractionLog.findMany({
      // Embedding-kind rows are operational search telemetry (SEARCH_DESIGN §9),
      // not extraction-quality data — keep them out of the tuning UI.
      where: { userId, kind: { not: "embedding" }, ...(reimbursementId ? { reimbursementId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        reimbursementId: true,
        kind: true,
        model: true,
        status: true,
        errorMessage: true,
        durationMs: true,
        createdAt: true,
      },
    });
    return NextResponse.json({ logs });
  });
}
