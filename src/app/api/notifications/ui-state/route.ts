import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { parseUiState } from "@/lib/notifications/ui-state";

export const runtime = "nodejs";

/**
 * §8.2/§8.4 notification UI state, per ACCOUNT (server-side): nudge
 * dismissals must not be trapped in one browser's storage on a shared
 * machine, and the iOS onboarding must be resumable from either context.
 * Plain UI state — never audited, no preferences here.
 */

export async function GET() {
  return handleApi(async () => {
    const userId = await requireUserId();
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { notifyUiStateJson: true },
    });
    return NextResponse.json(parseUiState(user?.notifyUiStateJson ?? "{}"));
  });
}

const PatchSchema = z.object({
  dismissNudge: z.string().max(40).optional(),
  onboardingStep: z.number().int().min(0).max(4).optional(),
});

export async function PATCH(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid ui-state update", "push.invalidUiState");
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { notifyUiStateJson: true },
    });
    const state = parseUiState(user?.notifyUiStateJson ?? "{}");
    if (parsed.data.dismissNudge && !state.dismissedNudges.includes(parsed.data.dismissNudge)) {
      state.dismissedNudges = [...state.dismissedNudges, parsed.data.dismissNudge].slice(-20);
    }
    if (parsed.data.onboardingStep !== undefined) state.onboardingStep = parsed.data.onboardingStep;
    await prisma.user.update({
      where: { id: userId },
      data: { notifyUiStateJson: JSON.stringify(state) },
    });
    return NextResponse.json(state);
  });
}
