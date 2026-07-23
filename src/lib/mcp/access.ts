import { prisma } from "@/lib/prisma";
import { isAppAdmin } from "@/lib/config";
import { canManageMinistries } from "@/lib/ministries-guard";
import { canManageTeams } from "@/lib/teams-guard";
import { accessibleScopes, type McpScope } from "@/lib/mcp/scopes";

/**
 * Which MCP scopes a user is ACTUALLY able to grant a token (docs/MCP_DESIGN.md).
 * SERVER ONLY (prisma). Mirrors the exact per-scope gates the MCP tools enforce
 * at call time — catalog:* needs the catalog manage role (ministries/positions:
 * canManageMinistries; teams: canManageTeams, both honoring the A10 duty pauses),
 * feedback:* needs app-admin — so the connection UI can hide, and the token
 * route refuse, any scope its owner couldn't exercise. A token never carries a
 * capability its owner lacks.
 */
export async function mcpAccessibleScopes(userId: string): Promise<McpScope[]> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, role: true, approvalsPaused: true, financePaused: true, adminPaused: true },
  });
  if (!u) return [];
  return accessibleScopes({
    canManageCatalog: canManageMinistries(u) || canManageTeams(u),
    isAppAdmin: isAppAdmin(u),
  });
}
