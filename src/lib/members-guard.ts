import { requireUserId, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { canManageMinistries } from "@/lib/ministries-guard";

/**
 * The Members page is finance/roster master data managed alongside Budget
 * Categories and Positions, so it is open to the same people: treasurers and
 * app-admins (`canManageMinistries`). Viewing the directory is the treasurer's
 * floor; the privileged actions on the page stay gated by their own guards
 * (role grants are root-signed roster events, the e-sign allowlist PATCH is
 * admin-only). As everywhere else, a caller who lacks the role gets 404,
 * never 403 (CLAUDE.md invariant #2).
 */
export { canManageMinistries as canViewMembers };

/** Gate the member-directory read API; returns the viewer's userId. SERVER ONLY. */
export async function requireMemberDirectoryViewer(): Promise<string> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, role: true },
  });
  if (!user || !canManageMinistries(user)) throw new ApiError(404, "Not found");
  return userId;
}
