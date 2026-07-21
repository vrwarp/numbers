import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { createMcpToken, listMcpTokens } from "@/lib/mcp/tokens";
import { isMcpScope, normalizeScopes } from "@/lib/mcp/scopes";

export const runtime = "nodejs";

/**
 * The user's MCP connections (personal access tokens for the MCP backend —
 * docs/MCP_DESIGN.md). This is the access-control surface: the owner chooses a
 * token's capabilities here, and can revoke it. The raw secret is returned
 * exactly once, by POST; no GET ever returns it (only the non-secret record).
 */

export async function GET() {
  return handleApi(async () => {
    const userId = await requireUserId();
    return NextResponse.json({ connections: await listMcpTokens(userId) });
  });
}

const CreateSchema = z.object({
  label: z.string().trim().min(1).max(100),
  scopes: z.array(z.string()).min(1),
  // 0 / omitted → never expires; otherwise days from now.
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      // Surface the most useful specific code the payload violated.
      const label = (parsed.error.issues.some((i) => i.path[0] === "label"));
      throw label
        ? new ApiError(400, "Give this connection a name", "mcpLabelRequired")
        : new ApiError(400, "Choose at least one capability", "mcpScopeRequired");
    }
    for (const s of parsed.data.scopes) {
      if (!isMcpScope(s)) throw new ApiError(400, `Unknown capability: ${s}`, "mcpInvalidScope", { scope: s });
    }
    const scopes = normalizeScopes(parsed.data.scopes);
    if (scopes.length === 0) throw new ApiError(400, "Choose at least one capability", "mcpScopeRequired");

    const expiresAt = parsed.data.expiresInDays
      ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
      : null;
    const { secret, record } = await createMcpToken(userId, parsed.data.label, scopes, expiresAt);
    // `token` is shown once and never persisted in cleartext.
    return NextResponse.json({ token: secret, connection: record }, { status: 201 });
  });
}
