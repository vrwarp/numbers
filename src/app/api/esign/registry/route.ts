import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { currentUser } from "@/auth";
import { esignRootEmail, esignRootFingerprint, isEsignMock } from "@/lib/config";
import { firebaseWebConfig } from "@/lib/firebase-admin";
import { getRegistry, reportRosterEvents } from "@/lib/esign/server";
import { openLedger } from "@/lib/esign/envelope";
import { replayRoster } from "@/lib/esign/roster";
import { keyFingerprint } from "@/lib/esign/canonical";
import type { RawLedgerEventDoc, RosterAction } from "@/lib/esign/types";
import type { VerifiedEvent } from "@/lib/esign/types";

export const runtime = "nodejs";

/**
 * E-sign registry (docs/ESIGN_DESIGN.md §6.2). GET describes the deployment
 * to the signed-in user; roster KEY MATERIAL is relayed only to enrolled
 * users (a SignerIdentity row exists) — an abuse dampener, not a security
 * boundary. POST is the root's one-time bootstrap ceremony.
 */

export async function GET() {
  return handleApi(async () => {
    const userId = await requireUserId();
    const user = await currentUser();
    const registry = await getRegistry();
    const identity = await prisma.signerIdentity.findUnique({ where: { userId } });
    const me = {
      userId,
      email: user!.email,
      name: user!.fullName || user!.email,
      role: user!.role,
      identityStatus: identity?.status ?? null,
      publicKey: identity?.publicKey || null,
      signatureImage: identity?.signatureImage || null,
    };
    const rootEmail = esignRootEmail();
    if (!registry) {
      return NextResponse.json({
        bootstrapped: false,
        backend: isEsignMock() ? "mock" : "firestore",
        canBootstrap: !!rootEmail && user!.email.toLowerCase() === rootEmail,
        me,
      });
    }
    const enrolled = !!identity;
    return NextResponse.json({
      bootstrapped: true,
      backend: isEsignMock() ? "mock" : "firestore",
      firebaseConfig: isEsignMock() ? null : firebaseWebConfig(),
      consentVersion: registry.consentVersion,
      rootPublicKey: registry.rootPublicKey,
      rootFingerprint: await keyFingerprint(registry.rootPublicKey),
      // Deployment pin (§4.6) — clients refuse a registry that mismatches it.
      configuredRootFingerprint: esignRootFingerprint() ?? null,
      rosterLedgerId: registry.rosterLedgerId,
      rosterLedgerKey: enrolled ? registry.rosterLedgerKey : null,
      me,
    });
  });
}

export async function POST(req: Request) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const user = await currentUser();
    const rootEmail = esignRootEmail();
    if (!rootEmail || user!.email.toLowerCase() !== rootEmail) {
      throw new ApiError(404, "Not found");
    }
    if (await getRegistry()) throw new ApiError(409, "E-sign registry already bootstrapped");

    const body = (await req.json()) as {
      rosterLedgerId?: string;
      rosterLedgerKey?: string;
      rootPublicKey?: string;
      genesisDoc?: RawLedgerEventDoc;
    };
    if (!body.rosterLedgerId || !body.rosterLedgerKey || !body.rootPublicKey || !body.genesisDoc) {
      throw new ApiError(400, "Missing bootstrap material");
    }

    // The genesis must decrypt with the offered key, be self-signed by the
    // offered root key, and name the bootstrapping user as root.
    const { events } = await openLedger(body.rosterLedgerKey, [body.genesisDoc]);
    if (events.length !== 1) throw new ApiError(409, "Genesis event does not verify");
    const roster = (() => {
      try {
        return replayRoster(body.rosterLedgerId!, events as VerifiedEvent<RosterAction>[]);
      } catch (err) {
        throw new ApiError(409, err instanceof Error ? err.message : "Bad genesis");
      }
    })();
    if (roster.root.publicKey !== body.rootPublicKey || roster.root.uid !== userId) {
      throw new ApiError(409, "Genesis root does not match the bootstrapping user");
    }
    const pin = esignRootFingerprint();
    if (pin && !(await keyFingerprint(body.rootPublicKey)).startsWith(pin)) {
      throw new ApiError(409, "Root key does not match ESIGN_ROOT_FINGERPRINT");
    }

    await prisma.$transaction([
      prisma.esignRegistry.create({
        data: {
          rosterLedgerId: body.rosterLedgerId,
          rosterLedgerKey: body.rosterLedgerKey,
          rootPublicKey: body.rootPublicKey,
          rootUserId: userId,
        },
      }),
      prisma.signerIdentity.upsert({
        where: { userId },
        create: { userId, publicKey: body.rootPublicKey, status: "attested", attestedAt: new Date() },
        update: { publicKey: body.rootPublicKey, status: "attested", attestedAt: new Date() },
      }),
      prisma.user.update({ where: { id: userId }, data: { role: "admin" } }),
      prisma.auditEvent.create({
        data: {
          userId,
          action: "esign-bootstrap",
          detail: JSON.stringify({
            rosterLedgerId: body.rosterLedgerId,
            rootPublicKey: body.rootPublicKey,
          }),
        },
      }),
    ]);
    const registry = (await getRegistry())!;
    await reportRosterEvents(registry, [body.genesisDoc]);
    return NextResponse.json({ ok: true });
  });
}
