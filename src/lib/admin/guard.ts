import { prisma } from "@/lib/prisma";
import { requireUserId, ApiError } from "@/lib/api";

/**
 * Gate an admin-only route. Like every cross-tenant surface in this app a
 * non-admin (or signed-out) caller gets **404, never 403** — the admin area's
 * existence isn't advertised to ordinary users (see CLAUDE.md invariant #2).
 * Returns the admin's userId. SERVER ONLY.
 */
export async function requireAdmin(): Promise<string> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "admin") throw new ApiError(404, "Not found");
  return userId;
}
