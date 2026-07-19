import { requireUserId, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { canManageMinistries } from "@/lib/ministries-guard";
import { searchCapabilities } from "@/lib/roles";
import { ROLE_MANAGER_ROLES } from "@/lib/esign/types";

/**
 * The Members page is finance/roster master data managed alongside Budget
 * Categories and Positions, open to the people who steward it: treasurers and
 * app-admins (`canManageMinistries`) plus the other executive officers —
 * chairman and secretary — whose role controls live here (A11,
 * `ROLE_MANAGER_ROLES`). Viewing the directory is the floor; the privileged
 * actions on the page stay gated by their own guards (role grants are signed
 * roster events the ledger re-checks, the e-sign allowlist PATCH is
 * admin-only).
 *
 * Like Budget Categories and Teams, it respects the A10 self-service duty
 * pauses: a role-holder who has paused every duty their role grants has stepped
 * back and drops to a member's view — same `searchCapabilities().canAll` test
 * used next door, so the whole cluster of admin/master-data surfaces vanishes
 * together instead of leaving this one reachable. As everywhere else, a caller
 * who lacks the role gets 404, never 403 (CLAUDE.md invariant #2).
 */
export function canViewMembers(user: {
  email: string;
  role: string;
  approvalsPaused?: boolean;
  financePaused?: boolean;
  adminPaused?: boolean;
}): boolean {
  if (canManageMinistries(user)) return true;
  const activeDuty = searchCapabilities({
    role: user.role,
    approvalsPaused: user.approvalsPaused ?? false,
    financePaused: user.financePaused ?? false,
    adminPaused: user.adminPaused ?? false,
  }).canAll;
  return (ROLE_MANAGER_ROLES as readonly string[]).includes(user.role) && activeDuty;
}

/** Gate the member-directory read API; returns the viewer's userId. SERVER ONLY. */
export async function requireMemberDirectoryViewer(): Promise<string> {
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
  if (!user || !canViewMembers(user)) throw new ApiError(404, "Not found");
  return userId;
}
