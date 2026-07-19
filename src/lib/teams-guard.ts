import { requireUserId, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { isAppAdmin } from "@/lib/config";
import { APPROVER_PLUS_ROLES } from "@/lib/esign/types";

/**
 * Teams are church master data (like Budget Categories and Positions) but are
 * deliberately opened wider: any Approver-or-above (approver/secretary/
 * chairman/treasurer/admin) — or an app-admin — may create and manage them.
 * Managing a team is stewardship, not an approval act, so the A10 approvals
 * pause does NOT narrow it (matching members-guard, which also checks the role
 * alone). As everywhere else, a caller who lacks the role gets 404, never 403
 * (CLAUDE.md invariant #2).
 *
 * NOTE the asymmetry, on purpose: managing teams is role-gated, but the read
 * grant a team confers derives ONLY from membership (src/lib/teams-catalog.ts)
 * — never from these roles and never from ADMIN_EMAILS.
 */
export function canManageTeams(user: { email: string; role: string; adminPaused?: boolean }): boolean {
  return (APPROVER_PLUS_ROLES as readonly string[]).includes(user.role) || isAppAdmin(user);
}

/** Gate the Teams write/read API; returns the editor's userId. SERVER ONLY. */
export async function requireTeamEditor(): Promise<string> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, role: true, adminPaused: true },
  });
  if (!user || !canManageTeams(user)) throw new ApiError(404, "Not found");
  return userId;
}
