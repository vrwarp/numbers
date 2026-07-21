import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getPublicOrigin } from "mcp-handler";
import { verifyMcpTokenSecret } from "@/lib/mcp/tokens";
import { publicBaseUrl } from "@/lib/config";

/**
 * The bridge between mcp-handler's `withMcpAuth` and our personal access
 * tokens (docs/MCP_DESIGN.md). It resolves the presented bearer token to an
 * `AuthInfo` whose `extra.userId` becomes the tenant key every tool query
 * filters by — the MCP analogue of `requireUserId()`. Returning `undefined`
 * makes the wrapper answer 401 (missing/invalid credential); the granted
 * scopes travel on `AuthInfo.scopes` for per-tool enforcement.
 *
 * We also capture the request's public origin here (this is the one place with
 * the Request in hand) so draft-producing tools can hand back an absolute
 * approval URL the assistant can pass to the user. The operator-declared
 * `PUBLIC_BASE_URL` wins when set (the canonical externally-reachable origin,
 * same one stamped on PDF QR codes); otherwise we derive it from the request's
 * forwarded host/proto headers.
 */
export async function verifyMcpToken(
  req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;
  const verified = await verifyMcpTokenSecret(bearerToken);
  if (!verified) return undefined;
  const origin = (publicBaseUrl() ?? safeOrigin(req)).replace(/\/+$/, "");
  return {
    // The wrapper stores this on req.auth; the tool layer reads scopes/extra,
    // never the raw token — but AuthInfo requires it, so echo it back.
    token: bearerToken,
    clientId: `mcp-token:${verified.tokenId}`,
    scopes: verified.scopes,
    extra: { userId: verified.userId, tokenId: verified.tokenId, origin },
  };
}

function safeOrigin(req: Request): string {
  try {
    return getPublicOrigin(req);
  } catch {
    return "";
  }
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

/** The request's public origin (no trailing slash), for building absolute
 *  approval URLs. Empty string if it couldn't be determined — callers then fall
 *  back to a root-relative path. */
export function originFrom(authInfo: AuthInfo | undefined): string {
  const origin = authInfo?.extra?.origin;
  return typeof origin === "string" ? origin : "";
}

/** Absolute URL for `path` (root-relative like "/claims/x") from the request
 *  origin; degrades to the relative path if the origin is unknown. */
export function approvalUrlFor(authInfo: AuthInfo | undefined, path: string): string {
  const origin = originFrom(authInfo);
  return origin ? `${origin}${path}` : path;
}
