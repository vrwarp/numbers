import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerMcpTools } from "@/lib/mcp/server";
import { verifyMcpToken } from "@/lib/mcp/auth";

/**
 * The Numbers MCP endpoint (docs/MCP_DESIGN.md), served over Streamable HTTP at
 * `/api/mcp` (the [transport] segment, with basePath "/api"). SSE (the
 * deprecated legacy transport) is disabled, and the handler is stateless — no
 * session affinity — so it stays forward-compatible with the stateless
 * transport direction.
 *
 * Auth is a personal access token (Bearer): `withMcpAuth` calls verifyMcpToken,
 * which resolves the token to its owner + granted scopes; unauthenticated calls
 * get 401. Per-tool scope checks and owner-scoping happen inside the tools.
 * There is no signing capability here by design.
 */

export const runtime = "nodejs";
// Draft help defaults to the no-AI "stored" path (fast); extractWithAi may call
// the provider and sit through quota cooldowns, so allow generous headroom.
export const maxDuration = 300;

const base = createMcpHandler(
  registerMcpTools,
  { serverInfo: { name: "numbers", version: "1.0.0" } },
  { basePath: "/api", disableSse: true, verboseLogs: false }
);

const handler = withMcpAuth(base, verifyMcpToken, { required: true });

export { handler as GET, handler as POST, handler as DELETE };
