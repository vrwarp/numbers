import { NextResponse } from "next/server";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { revokeMcpToken } from "@/lib/mcp/tokens";

export const runtime = "nodejs";

/** Revoke one MCP connection the caller owns (404 on any miss — invariant 2). */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const ok = await revokeMcpToken(userId, id);
    if (!ok) throw new ApiError(404, "Connection not found", "mcpTokenNotFound");
    return NextResponse.json({ ok: true });
  });
}
