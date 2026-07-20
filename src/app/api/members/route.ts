import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleApi } from "@/lib/api";
import { requireMemberDirectoryViewer } from "@/lib/members-guard";
import { keyFingerprint } from "@/lib/esign/canonical";
import { loadMemberPositionNames } from "@/lib/positions-catalog";

export const runtime = "nodejs";

/**
 * The Members page directory: EVERY user (not just the attested roster), with
 * their mirror role, Position, e-sign enrollment status, and rollout-allowlist
 * state — treasurer/admin gated (src/lib/members-guard.ts). This is a plain
 * app read of the verified mirror; nothing here touches roster validity. The
 * privileged mutations the page offers go through their own guards
 * (root-signed roster events for roles/keys, PATCH /api/esign/allowlist for
 * access). Read-only.
 */
export async function GET() {
  return handleApi(async () => {
    await requireMemberDirectoryViewer();
    const [users, positionNames] = await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          esignAllowed: true,
          prefersPaper: true,
          // NOTE (P8): esignNudgesJson (self-serve dismissals) must NEVER join
          // this select — a declined nudge is not admin-visible data.
          signerIdentity: {
            select: { status: true, attestedAt: true, createdAt: true, publicKey: true },
          },
        },
      }),
      loadMemberPositionNames(),
    ]);
    // Attested first (in attestation order, like the roster), then everyone
    // else in sign-up order — the page's two sections in one stable list.
    const rank = (u: (typeof users)[number]) =>
      u.signerIdentity?.status === "attested"
        ? u.signerIdentity.attestedAt?.getTime() ?? 0
        : Number.MAX_SAFE_INTEGER;
    const sorted = [...users].sort((a, b) => rank(a) - rank(b));
    const members = await Promise.all(
      sorted.map(async (u) => ({
        userId: u.id,
        name: u.fullName || u.email,
        email: u.email,
        role: u.role,
        position: positionNames.get(u.id) ?? null,
        allowed: u.esignAllowed,
        prefersPaper: u.prefersPaper,
        identityStatus: u.signerIdentity?.status ?? null,
        attestedAt: u.signerIdentity?.attestedAt ?? null,
        // Pending-age for the rollout tally ("waiting more than two weeks").
        identityCreatedAt: u.signerIdentity?.createdAt ?? null,
        publicKey: u.signerIdentity?.publicKey ?? null,
        fingerprint: u.signerIdentity?.publicKey
          ? await keyFingerprint(u.signerIdentity.publicKey)
          : null,
      }))
    );
    return NextResponse.json({ members });
  });
}
