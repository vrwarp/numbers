import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { appTimeZone, publicBaseUrl, esignRootFingerprint, FORM_ROWS_PER_PAGE } from "@/lib/config";
import { readStoredFile } from "@/lib/storage";
import { claimAccessRole, signedPacketPath } from "@/lib/esign/claim-server";
import { getRegistry, mirroredRawDocs } from "@/lib/esign/server";
import { CONSENT_TEXT } from "@/lib/esign/consent";
import { drawCertificateCover } from "@/lib/esign/certificate";
import { signatureAnchor } from "@/lib/pdf/generate";
import { loadTemplateBytes } from "@/lib/pdf/loadTemplate";
import {
  formatApprovalDate,
  pngFromDataUrl,
  stampApprovalMarks,
} from "@/lib/esign/approved-packet";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Approval certificate (docs/ESIGN_DESIGN.md §7.1): a cover page with the
 * UETA signature blocks, hashes, root fingerprint, and a QR to /v/<token>,
 * followed by the UNTOUCHED archived packet, with the raw verification
 * bundle embedded as a PDF attachment so the artifact stays independently
 * checkable offline (scripts/verify-bundle.mjs). Assembled from the
 * signature-verified mirror — the QR points back at cryptographic truth.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const bundleOnly = new URL(req.url).searchParams.get("bundle") === "1";
    const claim = await prisma.reimbursement.findUnique({
      where: { id },
      include: {
        user: { select: { fullName: true, email: true } },
        lineItems: { select: { isExcluded: true } },
      },
    });
    if (!claim) throw new ApiError(404, "Claim not found");
    await claimAccessRole(claim, userId);
    if (!["approved", "paid"].includes(claim.status)) {
      throw new ApiError(409, "Certificates exist once a claim is approved", "esign.certNotReady");
    }
    const registry = await getRegistry();
    if (!registry || !claim.signatureLedgerId || !claim.signatureLedgerKey || !claim.packetSha256) {
      throw new ApiError(409, "Claim has no signature ledger on record");
    }

    // Raw verification bundle (offline-checkable, §7.1) — also downloadable
    // alone via ?bundle=1 for scripts/verify-bundle.mjs.
    const bundle = {
      version: 1,
      claimId: id,
      ownerUid: claim.userId,
      packetSha256: claim.packetSha256,
      registry: {
        rosterLedgerId: registry.rosterLedgerId,
        rosterLedgerKey: registry.rosterLedgerKey,
        rootPublicKey: registry.rootPublicKey,
      },
      claimLedger: { ledgerId: claim.signatureLedgerId, ledgerKey: claim.signatureLedgerKey },
      rosterEvents: await mirroredRawDocs(registry.rosterLedgerId),
      claimEvents: await mirroredRawDocs(claim.signatureLedgerId),
      consentText: CONSENT_TEXT,
      generatedAtMs: Date.now(),
    };
    if (bundleOnly) return NextResponse.json(bundle);

    const packetBytes = await readStoredFile(
      signedPacketPath(claim.userId, id, claim.packetSha256)
    );
    const records = await prisma.signatureRecord.findMany({
      where: { reimbursementId: id, packetSha256: claim.packetSha256 },
      orderBy: { createdAt: "asc" },
    });
    const signerNames = new Map(
      (
        await prisma.user.findMany({
          where: { id: { in: records.map((r) => r.signerUserId) } },
          select: { id: true, fullName: true, email: true },
        })
      ).map((u) => [u.id, u.fullName || u.email])
    );

    const doc = await PDFDocument.create();
    await drawCertificateCover(doc, {
      claimId: id,
      ownerName: claim.user.fullName || claim.user.email,
      status: claim.status,
      checkNumber: claim.checkNumber,
      records,
      signerNames,
      packetSha256: claim.packetSha256,
      rootPublicKey: registry.rootPublicKey,
      rootPin: esignRootFingerprint(),
      publicToken: claim.publicToken,
      baseUrl: publicBaseUrl(),
    });

    await doc.attach(
      new TextEncoder().encode(JSON.stringify(bundle, null, 2)),
      "verification-bundle.json",
      { mimeType: "application/json", description: "Raw e-sign ledger events + keys for offline verification" }
    );

    // The pages after the cover are the APPROVED COPY when one is archived
    // (its hash is bound inside the signed APPROVE payload) — the archived
    // original stays untouched either way. Pre-feature approvals have no
    // archived copy, so the marks are restamped here from the signature
    // record, exactly as before.
    const deliveryBytes = claim.approvedPacketSha256
      ? await readStoredFile(
          signedPacketPath(claim.userId, id, claim.approvedPacketSha256)
        ).catch(() => packetBytes)
      : packetBytes;
    const packet = await PDFDocument.load(new Uint8Array(deliveryBytes), { ignoreEncryption: true });
    const pages = await doc.copyPages(packet, packet.getPageIndices());
    for (const p of pages) doc.addPage(p);

    const approveRecord = records.find((r) => r.kind === "approve");
    if (approveRecord && (!claim.approvedPacketSha256 || deliveryBytes === packetBytes)) {
      const approverIdentity = await prisma.signerIdentity.findUnique({
        where: { userId: approveRecord.signerUserId },
        select: { signatureImage: true },
      });
      const approvePayload = JSON.parse(approveRecord.payloadJson) as {
        ts?: number;
        signaturePlacement?: import("@/lib/esign/placement").SignaturePlacement;
      };
      const activeRows = claim.lineItems.filter((it) => !it.isExcluded).length;
      const formPageCount = Math.max(1, Math.ceil(activeRows / FORM_ROWS_PER_PAGE));
      // Cover page is index 0; packet form pages follow it.
      await stampApprovalMarks(doc, 1, Math.min(formPageCount, pages.length), {
        typedName: approveRecord.typedName || "",
        dateString: formatApprovalDate(approvePayload.ts ?? approveRecord.createdAt.getTime(), appTimeZone()),
        signaturePng: pngFromDataUrl(approverIdentity?.signatureImage),
        // The approver's click-placed position; fall back to the signature-
        // line anchor for older approvals with no recorded spot.
        placement:
          approvePayload.signaturePlacement ??
          (await signatureAnchor(await loadTemplateBytes(), "approver")),
      });
    }

    const bytes = await doc.save();
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        // `inline` so the browser opens the certificate in the viewer (like the
        // batch-print route) instead of downloading it; callers open it in a new
        // tab so the app stays put.
        "Content-Disposition": `inline; filename="approval-certificate-${id}.pdf"`,
      },
    });
  });
}
