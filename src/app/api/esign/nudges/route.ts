import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { mergeNudgeState, parseNudgeState } from "@/lib/esign/nudge-state";

export const runtime = "nodejs";

const PatchSchema = z
  .object({
    declined: z.literal(true),
    firstSeenMember: z.literal(true),
    dutySnooze: z.literal(true),
    paperRepeatShown: z.literal(true),
    closureShown: z.literal(true),
  })
  .partial();

/**
 * Self-serve e-sign nudge marks (docs/ESIGN_SETUP_DISCOVERABILITY.md). The
 * client sends INTENTS, never the whole state: the server re-reads the stored
 * JSON, applies the monotonic merge (booleans set-only, snooze counter grows,
 * firstSeen keeps its earliest value, unknown keys preserved), and writes back
 * — so a stale tab's PATCH can never resurrect a decline. Plain preference:
 * never audited, never readable by admins (`/api/members` must not grow it).
 */
export async function PATCH(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      throw new ApiError(400, "Invalid nudge update", "esign.invalidNudge");
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { esignNudgesJson: true },
    });
    if (!user) throw new ApiError(404, "User not found", "userNotFound");
    const next = mergeNudgeState(parseNudgeState(user.esignNudgesJson), parsed.data, new Date());
    const json = JSON.stringify(next);
    // Size backstop: the schema makes runaway growth impossible from clients,
    // but a corrupted-then-preserved unknown key must never wedge the row.
    if (json.length > 4096) throw new ApiError(400, "Nudge state too large", "esign.invalidNudge");
    await prisma.user.update({ where: { id: userId }, data: { esignNudgesJson: json } });
    return NextResponse.json({ ok: true });
  });
}
