import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { requireEnabledRegistry } from "@/lib/esign/server";

export const runtime = "nodejs";

/** Enrollment candidates awaiting vouches — the manual-entry fallback on the
 *  vouch screen (docs/ESIGN_DESIGN.md §4.3). Enrolled users only. */
export async function GET() {
  return handleApi(async () => {
    const userId = await requireUserId();
    await requireEnabledRegistry();
    const me = await prisma.signerIdentity.findUnique({ where: { userId } });
    if (!me) throw new ApiError(404, "Not enrolled");
    const rows = await prisma.signerIdentity.findMany({
      where: { status: "pending", publicKey: { not: "" } },
      include: { user: { select: { email: true, fullName: true } } },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({
      pending: rows.map((r) => ({
        uid: r.userId,
        email: r.user.email,
        name: r.user.fullName || r.user.email,
        publicKey: r.publicKey,
      })),
    });
  });
}
