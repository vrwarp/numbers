import { prisma } from "@/lib/prisma";
import { requireUserId, ApiError } from "@/lib/api";
import { isAppAdmin } from "@/lib/config";

/**
 * Gate an admin-only route. Like every cross-tenant surface in this app a
 * non-admin (or signed-out) caller gets **404, never 403** — the admin area's
 * existence isn't advertised to ordinary users (see CLAUDE.md invariant #2).
 * Admin = the verified roster role OR an ADMIN_EMAILS address (see isAppAdmin).
 * Returns the admin's userId. SERVER ONLY.
 */
export async function requireAdmin(): Promise<string> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, role: true, adminPaused: true },
  });
  if (!user || !isAppAdmin(user)) throw new ApiError(404, "Not found");
  return userId;
}
