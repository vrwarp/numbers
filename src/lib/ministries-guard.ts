import { prisma } from "@/lib/prisma";
import { requireUserId, ApiError } from "@/lib/api";
import { isAppAdmin } from "@/lib/config";

/**
 * The chart of accounts is finance master data, so the Budget Categories
 * editor is open to treasurers as well as app-admins (role "admin" or an
 * ADMIN_EMAILS address). Like every gated surface in this app, a caller who
 * lacks the role gets 404, never 403 (CLAUDE.md invariant #2).
 */
export function canManageMinistries(user: { role: string; email: string }): boolean {
  return user.role === "treasurer" || isAppAdmin(user);
}

/** Gate the Budget Categories write API; returns the editor's userId. SERVER ONLY. */
export async function requireMinistryEditor(): Promise<string> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, role: true },
  });
  if (!user || !canManageMinistries(user)) throw new ApiError(404, "Not found");
  return userId;
}
