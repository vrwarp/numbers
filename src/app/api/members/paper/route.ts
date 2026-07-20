import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { handleApi, ApiError } from "@/lib/api";
import { requireMemberDirectoryViewer } from "@/lib/members-guard";

export const runtime = "nodejs";

const Schema = z.object({ userId: z.string().min(1), prefersPaper: z.boolean() });

/**
 * "Prefers paper" (docs/ESIGN_SETUP_DISCOVERABILITY.md §3.6): recorded by an
 * officer AFTER a real conversation — it moves the member into the tally's
 * third bucket and silences every setup nudge for them. Deliberately a
 * human-entered fact (never inferred from dismissal telemetry, P8) and
 * AUDITED with the target user id, allowlist-precedent: it is an admin-side
 * write about another person.
 */
export async function PATCH(req: NextRequest) {
  return handleApi(async () => {
    const officerId = await requireMemberDirectoryViewer();
    const parsed = Schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid request", "invalidMemberUpdate");
    const target = await prisma.user.findUnique({
      where: { id: parsed.data.userId },
      select: { id: true, prefersPaper: true },
    });
    if (!target) throw new ApiError(404, "User not found", "userNotFound");
    if (target.prefersPaper !== parsed.data.prefersPaper) {
      await prisma.$transaction([
        prisma.user.update({
          where: { id: target.id },
          data: { prefersPaper: parsed.data.prefersPaper },
        }),
        prisma.auditEvent.create({
          data: {
            userId: officerId,
            action: "esign-prefers-paper",
            detail: JSON.stringify({
              targetUserId: target.id,
              prefersPaper: parsed.data.prefersPaper,
            }),
          },
        }),
      ]);
    }
    return NextResponse.json({ ok: true });
  });
}
