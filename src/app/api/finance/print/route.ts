import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { requireEsignAccess } from "@/lib/esign/server";
import { claimAccessRole, signedPacketPath } from "@/lib/esign/claim-server";
import { readStoredFile } from "@/lib/storage";
import { FORM_ROWS_PER_PAGE, publicBaseUrl, esignRootFingerprint } from "@/lib/config";
import { drawCertificateCover } from "@/lib/esign/certificate";
import { signatureAnchor } from "@/lib/pdf/generate";
import { loadTemplateBytes } from "@/lib/pdf/loadTemplate";
import { formatApprovalDate, pngFromDataUrl, stampApprovalMarks } from "@/lib/esign/approved-packet";
import type { SignaturePlacement } from "@/lib/esign/placement";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Cap so one request can't fan out into an unbounded PDF assembly. */
const MAX_PACKETS = 50;

/**
 * Batch packet print for the treasurer (Finance › Paid): one PDF concatenating
 * the selected approved/paid packets so a whole stack files in a single print
 * job. Read-only over the immutable signed archive — it never regenerates or
 * mutates the chain of custody (invariant #9); each claim's section is the
 * approved delivery copy, optionally prefixed with the signature certificate
 * cover and/or followed by its receipt pages.
 *
 * Gated exactly like GET /api/finance: a verified treasurer/admin whose finance
 * duty isn't paused (§6.2 / §6.3 role-read grant). Any miss is a 404.
 */
export async function POST(req: Request) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const registry = await requireEsignAccess(userId);
    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, financePaused: true },
    });
    if ((me?.role !== "treasurer" && me?.role !== "admin") || me.financePaused) {
      throw new ApiError(404, "Not found");
    }

    const body = (await req.json().catch(() => null)) as {
      ids?: unknown;
      includeReceipts?: unknown;
      includeCertificate?: unknown;
    } | null;
    const ids = Array.isArray(body?.ids)
      ? [...new Set(body!.ids.filter((x): x is string => typeof x === "string"))]
      : [];
    const includeReceipts = body?.includeReceipts === true;
    const includeCertificate = body?.includeCertificate === true;
    if (ids.length === 0) throw new ApiError(400, "Select at least one packet to print");
    if (ids.length > MAX_PACKETS) throw new ApiError(400, `Select at most ${MAX_PACKETS} packets`);

    const base = publicBaseUrl();
    const rootPin = esignRootFingerprint();
    const out = await PDFDocument.create();

    for (const id of ids) {
      const claim = await prisma.reimbursement.findUnique({
        where: { id },
        include: {
          user: { select: { fullName: true, email: true } },
          lineItems: { select: { isExcluded: true } },
        },
      });
      if (!claim) throw new ApiError(404, "Claim not found");
      // Fail-closed even for the role-read grant (cross-tenant ⇒ 404).
      await claimAccessRole(claim, userId);
      if (!["approved", "paid"].includes(claim.status) || !claim.packetSha256) {
        throw new ApiError(409, "Only approved or paid packets can be printed");
      }
      const packetSha256 = claim.packetSha256;

      const records = await prisma.signatureRecord.findMany({
        where: { reimbursementId: id, packetSha256 },
        orderBy: { createdAt: "asc" },
      });

      if (includeCertificate) {
        const signerNames = new Map(
          (
            await prisma.user.findMany({
              where: { id: { in: records.map((r) => r.signerUserId) } },
              select: { id: true, fullName: true, email: true },
            })
          ).map((u) => [u.id, u.fullName || u.email])
        );
        await drawCertificateCover(out, {
          claimId: id,
          ownerName: claim.user.fullName || claim.user.email,
          status: claim.status,
          checkNumber: claim.checkNumber,
          records,
          signerNames,
          packetSha256,
          rootPublicKey: registry.rootPublicKey,
          rootPin,
          publicToken: claim.publicToken,
          baseUrl: base,
        });
      }

      // The approved copy carries the approver's ink; fall back to the signed
      // submission packet and restamp for pre-feature approvals (mirrors the
      // certificate route). `inkBaked` tells us whether that restamp is needed.
      let deliveryBytes: Buffer;
      let inkBaked = false;
      if (claim.approvedPacketSha256) {
        try {
          deliveryBytes = await readStoredFile(
            signedPacketPath(claim.userId, id, claim.approvedPacketSha256)
          );
          inkBaked = true;
        } catch {
          deliveryBytes = await readStoredFile(signedPacketPath(claim.userId, id, packetSha256));
        }
      } else {
        deliveryBytes = await readStoredFile(signedPacketPath(claim.userId, id, packetSha256));
      }
      const packet = await PDFDocument.load(new Uint8Array(deliveryBytes), { ignoreEncryption: true });

      // Form pages come first in the packet; receipts (if any) follow. Drop the
      // receipt tail unless it was asked for.
      const activeRows = claim.lineItems.filter((it) => !it.isExcluded).length;
      const formPageCount = Math.max(1, Math.ceil(activeRows / FORM_ROWS_PER_PAGE));
      const allIndices = packet.getPageIndices();
      const wantIndices = includeReceipts
        ? allIndices
        : allIndices.slice(0, Math.min(formPageCount, allIndices.length));

      const formStart = out.getPageCount();
      const copied = await out.copyPages(packet, wantIndices);
      for (const p of copied) out.addPage(p);

      const approveRecord = records.find((r) => r.kind === "approve");
      if (!inkBaked && approveRecord) {
        const approverIdentity = await prisma.signerIdentity.findUnique({
          where: { userId: approveRecord.signerUserId },
          select: { signatureImage: true },
        });
        const approvePayload = JSON.parse(approveRecord.payloadJson) as {
          ts?: number;
          signaturePlacement?: SignaturePlacement;
        };
        await stampApprovalMarks(out, formStart, formPageCount, {
          typedName: approveRecord.typedName || "",
          dateString: formatApprovalDate(approvePayload.ts ?? approveRecord.createdAt.getTime()),
          signaturePng: pngFromDataUrl(approverIdentity?.signatureImage),
          placement:
            approvePayload.signaturePlacement ??
            (await signatureAnchor(await loadTemplateBytes(), "approver")),
        });
      }
    }

    const bytes = await out.save();
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="cfcc-packets-${ids.length}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
