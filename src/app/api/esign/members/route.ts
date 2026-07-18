import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { requireEsignAccess } from "@/lib/esign/server";
import { keyFingerprint } from "@/lib/esign/canonical";
import { loadMemberPositionNames } from "@/lib/positions-catalog";

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
    await requireEsignAccess(userId);
    const me = await prisma.signerIdentity.findUnique({ where: { userId } });
    if (!me) throw new ApiError(404, "Not enrolled", "esign.notEnrolled");

    const [identities, positionNames] = await Promise.all([
      prisma.signerIdentity.findMany({
        where: { status: "attested" },
        include: {
          user: {
            select: { id: true, email: true, fullName: true, role: true, approvalsPaused: true },
          },
        },
        orderBy: { attestedAt: "asc" },
      }),
      loadMemberPositionNames(),
    ]);
    const members = await Promise.all(
      identities.map(async (identity) => ({
        userId: identity.userId,
        name: identity.user.fullName || identity.user.email,
        email: identity.user.email,
        role: identity.user.role,
        // The member's custom approval role (Position), when they hold one — the
        // approver picker labels by this, falling back to `role`. null = none.
        position: positionNames.get(identity.userId) ?? null,
        // Duty pause (A10): the approver PICKER drops paused members; the
        // vouch screen (same payload) still lists them — availability is a
        // routing preference, not an identity/roster fact.
        approvalsPaused: identity.user.approvalsPaused,
        publicKey: identity.publicKey,
        fingerprint: identity.publicKey ? await keyFingerprint(identity.publicKey) : null,
      }))
    );
    return NextResponse.json({ members });
  });
}
