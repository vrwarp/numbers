import { requireUserId, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { canManageMinistries } from "@/lib/ministries-guard";
import { ROLE_MANAGER_ROLES } from "@/lib/esign/types";

/**
 * The Members page is finance/roster master data managed alongside Budget
 * Categories and Positions, open to the people who steward it: treasurers and
 * app-admins (`canManageMinistries`) plus the other executive officers —
 * chairman and secretary — whose role controls live here (A11,
 * `ROLE_MANAGER_ROLES`). Viewing the directory is the floor; the privileged
 * actions on the page stay gated by their own guards (role grants are signed
 * roster events the ledger re-checks, the e-sign allowlist PATCH is
 * admin-only). As everywhere else, a caller who lacks the role gets 404,
 * never 403 (CLAUDE.md invariant #2).
 */
export function canViewMembers(user: { email: string; role: string; adminPaused?: boolean }): boolean {
  return (
    canManageMinistries(user) || (ROLE_MANAGER_ROLES as readonly string[]).includes(user.role)
  );
}

/** Gate the member-directory read API; returns the viewer's userId. SERVER ONLY. */
export async function requireMemberDirectoryViewer(): Promise<string> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, role: true },
  });
  if (!user || !canViewMembers(user)) throw new ApiError(404, "Not found");
  return userId;
}
