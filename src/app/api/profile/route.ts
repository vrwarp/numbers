import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { setLocaleCookie } from "@/i18n/cookie";
import { LOCALES } from "@/lib/locales";
import { isAppAdmin } from "@/lib/config";
import { APPROVER_PLUS_ROLES, ROLE_MANAGER_ROLES } from "@/lib/esign/types";

export const runtime = "nodejs";

const userSelect = {
  id: true,
  email: true,
  fullName: true,
  mailingAddress: true,
  role: true,
  locale: true,
  approvalsPaused: true,
  financePaused: true,
  adminPaused: true,
  printIncludeReceipts: true,
  printIncludeCertificate: true,
} as const;

/** The GET/PATCH response: the row plus which duty toggles the user's grants
 *  make relevant (admin may come from ADMIN_EMAILS, not just the role). */
function profilePayload(user: {
  email: string;
  role: string;
  adminPaused: boolean;
  [k: string]: unknown;
}) {
  return {
    user,
    duties: {
      approvals: (APPROVER_PLUS_ROLES as readonly string[]).includes(user.role),
      finance: ["treasurer", "admin"].includes(user.role),
      // Pause state must not hide its own switch: judge adminship as if not
      // paused, so a paused admin still sees the toggle to unpause. Executive
      // officers get the toggle too — the same pause hides their role controls.
      admin:
        isAppAdmin({ ...user, adminPaused: false }) ||
        (ROLE_MANAGER_ROLES as readonly string[]).includes(user.role),
    },
  };
}

export async function GET() {
  return handleApi(async () => {
    const userId = await requireUserId();
    const user = await prisma.user.findUnique({ where: { id: userId }, select: userSelect });
    if (!user) throw new ApiError(404, "User not found", "userNotFound");
    return NextResponse.json(profilePayload(user));
  });
}

const PatchSchema = z
  .object({
    fullName: z.string().max(200),
    mailingAddress: z.string().max(500),
    locale: z.enum(LOCALES),
    // Duty pauses (A10): self-service, so no role precondition — pausing a
    // duty you don't hold is a harmless no-op, and flags survive role churn.
    approvalsPaused: z.boolean(),
    financePaused: z.boolean(),
    adminPaused: z.boolean(),
    // Treasurer batch-print toolbar toggles, remembered across devices. Plain
    // preferences (no role precondition, not audited) — the print route
    // re-reads the ids/content per request, so these only seed the UI.
    printIncludeReceipts: z.boolean(),
    printIncludeCertificate: z.boolean(),
  })
  .partial();

/** Save the name/address that get stamped onto the PDF form (+ UI language,
 *  + the self-service duty pause toggles — audited with field diffs). */
export async function PATCH(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid profile update", "invalidProfileUpdate");
    const before = await prisma.user.findUnique({ where: { id: userId }, select: userSelect });
    if (!before) throw new ApiError(404, "User not found", "userNotFound");
    const user = await prisma.user.update({
      where: { id: userId },
      data: parsed.data,
      select: userSelect,
    });
    // Availability changes route other people's work — keep the trail
    // (invariant 7). Plain profile fields stay un-audited as before.
    const changes: Record<string, { from: boolean; to: boolean }> = {};
    for (const flag of ["approvalsPaused", "financePaused", "adminPaused"] as const) {
      if (parsed.data[flag] !== undefined && before[flag] !== user[flag]) {
        changes[flag] = { from: before[flag], to: user[flag] };
      }
    }
    if (Object.keys(changes).length > 0) {
      await prisma.auditEvent.create({
        data: { userId, action: "update-availability", detail: JSON.stringify({ changes }) },
      });
    }
    // Keep the runtime cookie in step with the stored preference.
    if (parsed.data.locale) await setLocaleCookie(parsed.data.locale);
    return NextResponse.json(profilePayload(user));
  });
}
