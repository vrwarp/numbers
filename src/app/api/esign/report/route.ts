import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { reportRosterEvents, requireRegistry } from "@/lib/esign/server";

export const runtime = "nodejs";

/**
 * Roster event report (docs/ESIGN_DESIGN.md §5.5): clients push raw event
 * docs (the server cannot read the ledger itself); the server decrypts,
 * verifies signatures, re-runs the roster reducer, and only then updates the
 * SignerIdentity / User.role mirrors. Unverifiable reports change nothing.
 */
export async function POST(req: Request) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const registry = await requireRegistry();
    const enrolled = await prisma.signerIdentity.findUnique({ where: { userId } });
    if (!enrolled) throw new ApiError(404, "Not enrolled");
    const body = (await req.json()) as { events?: unknown };
    const roster = await reportRosterEvents(registry, body.events);
    return NextResponse.json({
      attestedKeys: roster.members.filter((m) => m.revokedAtMs === undefined).length,
      pending: roster.pending.size,
      anomalies: roster.anomalies.length,
    });
  });
}
