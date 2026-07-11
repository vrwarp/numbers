import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { requireRegistry } from "@/lib/esign/server";
import { CONSENT_VERSION } from "@/lib/esign/consent";

export const runtime = "nodejs";

/**
 * Begin (or continue) enrollment (docs/ESIGN_DESIGN.md §4.2): creates the
 * caller's SignerIdentity row — which is what unlocks the roster key relay —
 * and records their roster public key once the client has generated it.
 * Status stays `pending` until the report pipeline verifies real ATTEST
 * events (§5.5); nothing here grants attestation.
 */
export async function POST(req: Request) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const registry = await requireRegistry();
    const body = (await req.json().catch(() => ({}))) as {
      publicKey?: string;
      consentVersion?: string;
    };
    if (body.publicKey !== undefined && !/^[A-Za-z0-9+/=]{40,400}$/.test(body.publicKey)) {
      throw new ApiError(400, "Bad public key");
    }

    const existing = await prisma.signerIdentity.findUnique({ where: { userId } });
    if (!existing) {
      await prisma.$transaction([
        prisma.signerIdentity.create({
          data: { userId, publicKey: body.publicKey ?? "" },
        }),
        // First-use UETA consent acknowledgment (§4.2) — the load-bearing
        // consent evidence is the consentSha256 inside each signed payload.
        prisma.auditEvent.create({
          data: {
            userId,
            action: "esign-consent",
            detail: JSON.stringify({ consentVersion: body.consentVersion ?? CONSENT_VERSION }),
          },
        }),
      ]);
    } else if (body.publicKey && body.publicKey !== existing.publicKey) {
      // A new key (fresh enrollment after key loss) restarts attestation.
      await prisma.signerIdentity.update({
        where: { userId },
        data: { publicKey: body.publicKey, status: "pending", attestedAt: null },
      });
    }

    const identity = await prisma.signerIdentity.findUnique({ where: { userId } });
    return NextResponse.json({
      identityStatus: identity!.status,
      publicKey: identity!.publicKey || null,
      rosterLedgerId: registry.rosterLedgerId,
      rosterLedgerKey: registry.rosterLedgerKey,
      rootPublicKey: registry.rootPublicKey,
    });
  });
}
