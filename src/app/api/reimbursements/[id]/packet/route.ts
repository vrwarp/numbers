import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { readStoredFile, generatedPdfPath } from "@/lib/storage";
import { claimAccessRole, SHA256_HEX, signedPacketPath } from "@/lib/esign/claim-server";
import { SIGNED_STATUSES } from "@/lib/esign/types";

export const runtime = "nodejs";

/**
 * Packet bytes (docs/ESIGN_DESIGN.md §5.1/§6.2): the stored packet while
 * `generated`, the immutable archive once signed; `?sha=` selects a version.
 * Access: owner, assigned approver, or treasurer — one of the deliberate
 * non-owner grants of §6.3. Clients hash these exact bytes for ceremonies.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const claim = await prisma.reimbursement.findUnique({ where: { id } });
    if (!claim) throw new ApiError(404, "Claim not found");
    await claimAccessRole(claim, userId);

    const shaParam = new URL(req.url).searchParams.get("sha");
    if (shaParam !== null && !SHA256_HEX.test(shaParam)) throw new ApiError(400, "Bad sha");

    let relPath: string;
    if (shaParam) {
      relPath = signedPacketPath(claim.userId, id, shaParam);
    } else if (["approved", "paid"].includes(claim.status) && claim.approvedPacketSha256) {
      // Once approved, the default download is the APPROVED COPY — the packet
      // with the approver's ink/name/date stamped on, its hash bound inside
      // the signed APPROVE payload. The untouched original stays selectable
      // via ?sha=<packetSha256>; ceremonies always fetch by explicit sha.
      relPath = signedPacketPath(claim.userId, id, claim.approvedPacketSha256);
    } else if ((SIGNED_STATUSES as readonly string[]).includes(claim.status) && claim.packetSha256) {
      relPath = signedPacketPath(claim.userId, id, claim.packetSha256);
    } else if (claim.status === "generated") {
      relPath = generatedPdfPath(claim.userId, id);
    } else {
      throw new ApiError(404, "No packet for this claim yet", "esign.noPacket");
    }
    const bytes = await readStoredFile(relPath).catch(() => {
      throw new ApiError(404, "Packet not found");
    });
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="cfcc-reimbursement-${id}.pdf"`,
        // A ?sha= request is content-addressed into the immutable signed
        // archive (never regenerated or overwritten), so the browser may
        // keep it: ceremony re-fetches of the same bytes then skip a
        // multi-megabyte download. The default selection is status-dependent
        // and `generated` bytes are mutable — those stay uncacheable.
        "Cache-Control": shaParam ? "private, max-age=31536000, immutable" : "no-store",
      },
    });
  });
}
