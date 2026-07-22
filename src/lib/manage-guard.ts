import { isAppAdmin } from "@/lib/config";
import { canManageMinistries } from "@/lib/ministries-guard";
import { canManageTeams } from "@/lib/teams-guard";
import { canViewMembers } from "@/lib/members-guard";

/**
 * Can the user reach ANY organization-management surface? The union of the
 * per-tool gates (budget categories/positions → canManageMinistries; teams →
 * canManageTeams; members → canViewMembers; admin → isAppAdmin). Drives the
 * "Manage" nav entry and the /manage hub landing.
 *
 * This is a LAUNCHER gate, not a security boundary: it only decides whether the
 * hub and its entry point are shown. Every destination page keeps its own
 * redirect guard and every API keeps its own role check (CLAUDE.md invariant
 * #2), so a caller who slips past this still gets 404'd at the real edge. The
 * component guards already fold in the A10 duty pauses, so a fully-paused
 * role-holder drops to a member's view here too.
 */
export function canManageOrg(user: {
  email: string;
  role: string;
  approvalsPaused?: boolean;
  financePaused?: boolean;
  adminPaused?: boolean;
}): boolean {
  return (
    isAppAdmin(user) ||
    canManageMinistries(user) || // implies canViewMembers
    canManageTeams(user) ||
    canViewMembers(user)
  );
}
