import { prisma } from "@/lib/prisma";
import { requireUserId, ApiError } from "@/lib/api";
import { isAppAdmin } from "@/lib/config";
import { searchCapabilities } from "@/lib/roles";

/**
 * The chart of accounts is finance master data, so the Budget Categories
 * editor is open to treasurers as well as app-admins (role "admin" or an
 * ADMIN_EMAILS address).
 *
 * Like the sibling Teams editor (src/lib/teams-guard.ts) — and unlike the raw
 * role check this used to be — it respects the A10 self-service duty pauses:
 * a treasurer/admin who has paused every duty their role grants has stepped
 * back from cross-tenant service and loses the editor with the rest of it
 * (`searchCapabilities().canAll` — approvals OR finance for a treasurer, plus
 * admin for an app-admin). A treasurer who pauses only one duty keeps it. The
 * ADMIN_EMAILS path honors adminPaused via isAppAdmin. As everywhere else, a
 * caller who lacks the grant gets 404, never 403 (CLAUDE.md invariant #2).
 */
export function canManageMinistries(user: {
  role: string;
  email: string;
  approvalsPaused?: boolean;
  financePaused?: boolean;
  adminPaused?: boolean;
}): boolean {
  const financeRole = user.role === "treasurer" || user.role === "admin";
  const activeDuty = searchCapabilities({
    role: user.role,
    approvalsPaused: user.approvalsPaused ?? false,
    financePaused: user.financePaused ?? false,
    adminPaused: user.adminPaused ?? false,
  }).canAll;
  return (financeRole && activeDuty) || isAppAdmin(user);
}

/** Gate the Budget Categories write API; returns the editor's userId. SERVER ONLY. */
export async function requireMinistryEditor(): Promise<string> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      role: true,
      approvalsPaused: true,
      financePaused: true,
      adminPaused: true,
    },
  });
  if (!user || !canManageMinistries(user)) throw new ApiError(404, "Not found");
  return userId;
}
