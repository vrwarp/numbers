import { NextResponse } from "next/server";
import { handleApi } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { computeHealth, computeStats } from "@/lib/admin/overview";

export const runtime = "nodejs";

/**
 * Admin dashboard payload (docs/ADMIN.md): "problems" health checks + headline
 * usage stats. Read-only; admin-gated (404 for everyone else).
 */
export async function GET() {
  return handleApi(async () => {
    await requireAdmin();
    const [health, stats] = await Promise.all([computeHealth(), computeStats()]);
    return NextResponse.json({ health, stats });
  });
}
