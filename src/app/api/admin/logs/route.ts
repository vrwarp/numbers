import { NextResponse } from "next/server";
import { handleApi } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * Cross-user audit + extraction trail for troubleshooting (docs/ADMIN.md).
 * Admin-only, so the cross-tenant read is intentional. Extraction defaults to
 * FAILURES (`?extraction=all` for successes too) since problems are what an
 * admin comes here for. Read-only.
 */
export async function GET(req: Request) {
  return handleApi(async () => {
    await requireAdmin();
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || undefined;
    const extractionAll = url.searchParams.get("extraction") === "all";
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);

    const [audit, extraction] = await Promise.all([
      prisma.auditEvent.findMany({
        where: action ? { action } : undefined,
        orderBy: { createdAt: "desc" },
        take: limit,
        include: { user: { select: { email: true, fullName: true } } },
      }),
      prisma.extractionLog.findMany({
        where: extractionAll ? undefined : { status: "error" },
        orderBy: { createdAt: "desc" },
        take: limit,
        include: { user: { select: { email: true, fullName: true } } },
      }),
    ]);

    const distinctActions = await prisma.auditEvent.findMany({
      distinct: ["action"],
      select: { action: true },
      orderBy: { action: "asc" },
    });

    return NextResponse.json({
      actions: distinctActions.map((a) => a.action),
      audit: audit.map((e) => ({
        id: e.id,
        action: e.action,
        detail: e.detail,
        createdAt: e.createdAt,
        reimbursementId: e.reimbursementId,
        user: e.user.fullName || e.user.email,
      })),
      extraction: extraction.map((e) => ({
        id: e.id,
        kind: e.kind,
        model: e.model,
        status: e.status,
        errorMessage: e.errorMessage,
        durationMs: e.durationMs,
        createdAt: e.createdAt,
        reimbursementId: e.reimbursementId,
        user: e.user.fullName || e.user.email,
      })),
    });
  });
}
