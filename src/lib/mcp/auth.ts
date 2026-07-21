import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { verifyMcpTokenSecret } from "@/lib/mcp/tokens";

/**
 * The bridge between mcp-handler's `withMcpAuth` and our personal access
 * tokens (docs/MCP_DESIGN.md). It resolves the presented bearer token to an
 * `AuthInfo` whose `extra.userId` becomes the tenant key every tool query
 * filters by — the MCP analogue of `requireUserId()`. Returning `undefined`
 * makes the wrapper answer 401 (missing/invalid credential); the granted
 * scopes travel on `AuthInfo.scopes` for per-tool enforcement.
 */
export async function verifyMcpToken(
  _req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;
  const verified = await verifyMcpTokenSecret(bearerToken);
  if (!verified) return undefined;
  return {
    // The wrapper stores this on req.auth; the tool layer reads scopes/extra,
    // never the raw token — but AuthInfo requires it, so echo it back.
    token: bearerToken,
    clientId: `mcp-token:${verified.tokenId}`,
    scopes: verified.scopes,
    extra: { userId: verified.userId, tokenId: verified.tokenId },
  };
}

/** Pull the tenant user id off a tool call's auth context, or throw. Tools are
 *  only ever reached through `withMcpAuth(required)`, so a missing id is a bug,
 *  not a client error. */
export function userIdFrom(authInfo: AuthInfo | undefined): string {
  const userId = authInfo?.extra?.userId;
  if (typeof userId !== "string" || !userId) {
    throw new Error("MCP tool invoked without a resolved user");
  }
  return userId;
}
