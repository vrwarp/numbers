import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleApi, ApiError } from "@/lib/api";
import { esignRootFingerprint } from "@/lib/config";
import { readStoredFile } from "@/lib/storage";
import { getRegistry, mirroredRawDocs } from "@/lib/esign/server";
import { claimSummary, SHA256_HEX, signedPacketPath } from "@/lib/esign/claim-server";
import { keyFingerprint } from "@/lib/esign/canonical";

export const runtime = "nodejs";

/**
 * Token-authorized verification API (docs/ESIGN_DESIGN.md §6.2, §7.2) — the
 * ONE e-sign surface with no sign-in, `/c/<token>`-style: the unguessable
 * publicToken is the credential. Serves everything the /v page verifies
 * client-side: claim summary + ledger key, registry pin, mirrored raw
 * events, archived packet bytes. Works even after the claim row is deleted
 * (EsignClaimArchive is the retention pointer). 404 on any miss.
 */

async function resolveToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,60}$/.test(token)) throw new ApiError(404, "Not found");
  const claim = await prisma.reimbursement.findUnique({
    where: { publicToken: token },
    include: { lineItems: true, user: { select: { fullName: true, email: true } } },
  });
  if (claim?.signatureLedgerId && claim.signatureLedgerKey) {
    return {
      claim,
      claimId: claim.id,
      userId: claim.userId,
      ledgerId: claim.signatureLedgerId,
      ledgerKey: claim.signatureLedgerKey,
      packetSha256: claim.packetSha256,
      submitSeq: claim.submitSeq,
    };
  }
  // Deleted (or reverted-and-deleted) claim: the retention row still serves.
  const archive = await prisma.esignClaimArchive.findFirst({ where: { publicToken: token } });
  if (!archive) throw new ApiError(404, "Not found");
  return {
    claim: null,
    claimId: archive.claimId,
    userId: archive.userId,
    ledgerId: archive.ledgerId,
    ledgerKey: archive.ledgerKey,
    packetSha256: null,
    submitSeq: null,
  };
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ token: string; part: string }> }
) {
  return handleApi(async () => {
    const { token, part } = await ctx.params;
    const resolved = await resolveToken(token);

    if (part === "summary") {
      return NextResponse.json({
        claimId: resolved.claimId,
        ownerUid: resolved.userId,
        ledgerId: resolved.ledgerId,
        ledgerKey: resolved.ledgerKey,
        packetSha256: resolved.packetSha256,
        submitSeq: resolved.submitSeq,
        status: resolved.claim?.status ?? "deleted",
        summary: resolved.claim
          ? claimSummary(resolved.claim, resolved.claim.user.fullName || resolved.claim.user.email)
          : null,
      });
    }

    if (part === "registry") {
      const registry = await getRegistry();
      if (!registry) throw new ApiError(404, "Not found");
      return NextResponse.json({
        rosterLedgerId: registry.rosterLedgerId,
        rosterLedgerKey: registry.rosterLedgerKey,
        rootPublicKey: registry.rootPublicKey,
        rootFingerprint: await keyFingerprint(registry.rootPublicKey),
        configuredRootFingerprint: esignRootFingerprint() ?? null,
        consentVersion: registry.consentVersion,
      });
    }

    if (part === "events") {
      const registry = await getRegistry();
      if (!registry) throw new ApiError(404, "Not found");
      return NextResponse.json({
        roster: await mirroredRawDocs(registry.rosterLedgerId),
        claim: await mirroredRawDocs(resolved.ledgerId),
      });
    }

    if (part === "packet") {
      const sha = new URL(req.url).searchParams.get("sha") ?? resolved.packetSha256;
      if (!sha || !SHA256_HEX.test(sha)) throw new ApiError(404, "Not found");
      const bytes = await readStoredFile(signedPacketPath(resolved.userId, resolved.claimId, sha)).catch(
        () => {
          throw new ApiError(404, "Not found");
        }
      );
      return new NextResponse(new Uint8Array(bytes), {
        headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" },
      });
    }

    throw new ApiError(404, "Not found");
  });
}
