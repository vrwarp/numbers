import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { requireRegistry } from "@/lib/esign/server";
import { keyFingerprint } from "@/lib/esign/canonical";

export const runtime = "nodejs";

/**
 * Attested members from the VERIFIED mirror (docs/ESIGN_DESIGN.md §6.2) —
 * feeds the vouch screen and the approver picker. Enrolled users only: the
 * directory isn't handed to drive-by Google accounts (an abuse dampener,
 * not a security boundary).
 */
export async function GET() {
  return handleApi(async () => {
    const userId = await requireUserId();
    await requireRegistry();
    const me = await prisma.signerIdentity.findUnique({ where: { userId } });
    if (!me) throw new ApiError(404, "Not enrolled");

    const identities = await prisma.signerIdentity.findMany({
      where: { status: "attested" },
      include: { user: { select: { id: true, email: true, fullName: true, role: true } } },
      orderBy: { attestedAt: "asc" },
    });
    const members = await Promise.all(
      identities.map(async (identity) => ({
        userId: identity.userId,
        name: identity.user.fullName || identity.user.email,
        email: identity.user.email,
        role: identity.user.role,
        publicKey: identity.publicKey,
        fingerprint: identity.publicKey ? await keyFingerprint(identity.publicKey) : null,
      }))
    );
    return NextResponse.json({ members });
  });
}
