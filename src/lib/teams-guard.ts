import { requireUserId, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { isAppAdmin } from "@/lib/config";
import { searchCapabilities } from "@/lib/roles";

/**
 * Teams are church master data (like Budget Categories and Positions) but are
 * deliberately opened wider: any Approver-or-above (approver/secretary/
 * chairman/treasurer/admin) — or an app-admin — may create and manage them.
 *
 * The A10 duty pauses narrow this the same way they narrow the role-read grant
 * (`searchCapabilities().canAll`): managing teams requires at least one ACTIVE
 * (un-paused) duty the role grants — a role-holder who has paused every
 * relevant duty has stepped back from cross-tenant service and loses the teams
 * editor with the rest of it. An approver who pauses Approvals loses it (no
 * fallback duty); a treasurer who pauses only Approvals keeps it (Finance
 * still active). The ADMIN_EMAILS path already honors adminPaused via
 * isAppAdmin. As everywhere else, a caller who lacks the grant gets 404,
 * never 403 (CLAUDE.md invariant #2).
 *
 * NOTE the asymmetry, on purpose: managing teams is role+duty-gated, but the
 * READ grant a team confers derives ONLY from membership
 * (src/lib/teams-catalog.ts) — pauses never touch it, and it never comes from
 * these roles or ADMIN_EMAILS.
 */
export function canManageTeams(user: {
  email: string;
  role: string;
  approvalsPaused?: boolean;
  financePaused?: boolean;
  adminPaused?: boolean;
}): boolean {
  const activeDuty = searchCapabilities({
    role: user.role,
    approvalsPaused: user.approvalsPaused ?? false,
    financePaused: user.financePaused ?? false,
    adminPaused: user.adminPaused ?? false,
  }).canAll;
  return activeDuty || isAppAdmin(user);
}

/** Gate the Teams write/read API; returns the editor's userId. SERVER ONLY. */
export async function requireTeamEditor(): Promise<string> {
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
  if (!user || !canManageTeams(user)) throw new ApiError(404, "Not found");
  return userId;
}
