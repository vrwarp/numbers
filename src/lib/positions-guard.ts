import { requireUserId, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { canManageMinistries } from "@/lib/ministries-guard";

/**
 * Positions are finance master data managed alongside the chart of accounts, so
 * the editor is open to the same people as Budget Categories: treasurers and
 * app-admins (`canManageMinistries`). As everywhere else, a caller who lacks the
 * role gets 404, never 403 (CLAUDE.md invariant #2).
 */
export { canManageMinistries as canManagePositions };

/** Gate the Positions write/read API; returns the editor's userId. SERVER ONLY. */
export async function requirePositionEditor(): Promise<string> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, role: true },
  });
  if (!user || !canManageMinistries(user)) throw new ApiError(404, "Not found");
  return userId;
}
