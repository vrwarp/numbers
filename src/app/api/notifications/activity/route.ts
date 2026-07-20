import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi } from "@/lib/api";
import { isNotificationKind, type NotificationParams } from "@/lib/notifications/catalog";

export const runtime = "nodejs";

/**
 * §5 in-app parity: the recipient's own NotificationJob rows as a
 * reverse-chronological activity list — written regardless of push
 * preferences, so a push-less member sees the same facts, merely later.
 * Strictly owner-scoped (invariant 2); no read-tracking (§2): the list is
 * informational and nothing records that it was seen. Localized text is
 * composed client-side (render time, viewer's locale) from the params —
 * payloadJson text is never stored or relayed as prose.
 */
export async function GET(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? 20);
    const limit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 20));

    const rows = await prisma.notificationJob.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, kind: true, targetId: true, payloadJson: true, createdAt: true },
    });

    // §11 dead-target state: a deleted claim renders as "a deleted claim",
    // with no dead deep link.
    const claimIds = [
      ...new Set(
        rows.filter((r) => r.kind.startsWith("claim") || r.kind === "signing-request" || r.kind === "finance-queue").map((r) => r.targetId)
      ),
    ];
    const existing = new Set(
      (
        await prisma.reimbursement.findMany({
          where: { id: { in: claimIds } },
          select: { id: true },
        })
      ).map((c) => c.id)
    );

    const items = rows
      .filter((r) => isNotificationKind(r.kind))
      .map((r) => {
        let params: NotificationParams | null = null;
        try {
          params = JSON.parse(r.payloadJson) as NotificationParams;
        } catch {
          params = null;
        }
        const claimKind =
          r.kind === "signing-request" || r.kind === "finance-queue" || r.kind.startsWith("claim");
        return {
          id: r.id,
          kind: r.kind,
          targetId: r.targetId,
          createdAt: r.createdAt,
          label: params?.label ?? "",
          name: params?.name ?? "",
          targetGone: claimKind && !existing.has(r.targetId),
        };
      });

    return NextResponse.json({ items });
  });
}
