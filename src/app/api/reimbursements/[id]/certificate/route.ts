import { NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import qrcode from "qrcode-generator";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { publicBaseUrl } from "@/lib/config";
import { esignRootFingerprint } from "@/lib/config";
import { readStoredFile } from "@/lib/storage";
import { claimAccessRole, signedPacketPath } from "@/lib/esign/claim-server";
import { getRegistry, mirroredRawDocs } from "@/lib/esign/server";
import { fingerprintDisplay, keyFingerprint } from "@/lib/esign/canonical";
import { CONSENT_TEXT } from "@/lib/esign/consent";
import { signatureAnchor, stampSignatureAt } from "@/lib/pdf/generate";
import { loadTemplateBytes } from "@/lib/pdf/loadTemplate";
import { FORM_ROWS_PER_PAGE } from "@/lib/config";

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
      throw new ApiError(409, "Certificates exist once a claim is approved");
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
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([612, 792]);
    let y = 740;
    const text = (s: string, opts: { size?: number; bold?: boolean; x?: number; color?: [number, number, number] } = {}) => {
      page.drawText(s, {
        x: opts.x ?? 56,
        y,
        size: opts.size ?? 10,
        font: opts.bold ? helvBold : helv,
        color: opts.color ? rgb(...opts.color) : rgb(0.1, 0.09, 0.08),
      });
      y -= (opts.size ?? 10) + 6;
    };

    text("Reimbursement Approval Certificate", { size: 18, bold: true });
    text("Cornerstone Faith Community Church — electronic signature record", {
      size: 9,
      color: [0.4, 0.38, 0.35],
    });
    y -= 8;
    text(`Requested by: ${claim.user.fullName || claim.user.email}`, { size: 11 });
    text(`Claim: ${id}`, { size: 9, color: [0.4, 0.38, 0.35] });
    text(
      `Status: ${claim.status.toUpperCase()}${claim.checkNumber ? `  ·  Check #${claim.checkNumber}` : ""}`,
      { size: 11, bold: true }
    );
    y -= 6;

    for (const record of records) {
      const payload = JSON.parse(record.payloadJson) as { ts?: number; consentVersion?: string; comment?: string };
      const fp = fingerprintDisplay(await keyFingerprint(record.signerPublicKey));
      const when = payload.ts ? new Date(payload.ts).toISOString() : record.createdAt.toISOString();
      text(
        `${record.kind.toUpperCase()} — ${signerNames.get(record.signerUserId) ?? "unknown"}`,
        { size: 12, bold: true }
      );
      if (record.typedName) text(`Signed name: "${record.typedName}"`, { size: 10 });
      text(`Time (signer clock): ${when}    Consent: ${payload.consentVersion ?? "—"}`, {
        size: 9,
        color: [0.35, 0.33, 0.3],
      });
      text(`Key fingerprint: ${fp}    Event: ${record.ledgerEventId}`, {
        size: 9,
        color: [0.35, 0.33, 0.3],
      });
      if (payload.comment) text(`Comment: "${payload.comment}"`, { size: 9 });
      y -= 4;
    }

    y -= 4;
    text(`Packet SHA-256: ${claim.packetSha256}`, { size: 8, color: [0.35, 0.33, 0.3] });
    const rootFp = await keyFingerprint(registry.rootPublicKey);
    text(`Church root fingerprint: ${rootFp}`, { size: 8, color: [0.35, 0.33, 0.3] });
    text("Compare the root fingerprint against the value your church published.", {
      size: 8,
      color: [0.5, 0.35, 0.1],
    });
    const pin = esignRootFingerprint();
    if (pin) text(`Deployment pin (prefix): ${pin}`, { size: 8, color: [0.35, 0.33, 0.3] });
    y -= 6;
    text(
      "The pages after this cover are the signed packet, with the approval signature stamped on",
      { size: 8, color: [0.4, 0.38, 0.35] }
    );
    text(
      "for filing. The untouched original is archived and one QR scan away; this PDF also embeds",
      { size: 8, color: [0.4, 0.38, 0.35] }
    );
    text(
      "verification-bundle.json — verify offline with scripts/verify-bundle.mjs and the root fingerprint.",
      { size: 8, color: [0.4, 0.38, 0.35] }
    );

    // QR to the live verification page, when the deployment knows its origin.
    const base = publicBaseUrl();
    if (base && claim.publicToken) {
      const qr = qrcode(0, "M");
      qr.addData(`${base}/v/${claim.publicToken}`);
      qr.make();
      const n = qr.getModuleCount();
      const size = 110;
      const cell = size / n;
      const x0 = 612 - 56 - size;
      const y0 = 792 - 56 - size;
      page.drawRectangle({ x: x0 - 4, y: y0 - 4, width: size + 8, height: size + 8, color: rgb(1, 1, 1) });
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.isDark(r, c)) {
            page.drawRectangle({
              x: x0 + c * cell,
              y: y0 + (n - 1 - r) * cell,
              width: cell,
              height: cell,
              color: rgb(0.1, 0.09, 0.08),
            });
          }
        }
      }
      page.drawText("scan to verify", {
        x: x0 + 22,
        y: y0 - 14,
        size: 8,
        font: helv,
        color: rgb(0.4, 0.38, 0.35),
      });
    }

    await doc.attach(
      new TextEncoder().encode(JSON.stringify(bundle, null, 2)),
      "verification-bundle.json",
      { mimeType: "application/json", description: "Raw e-sign ledger events + keys for offline verification" }
    );

    const packet = await PDFDocument.load(packetBytes, { ignoreEncryption: true });
    const pages = await doc.copyPages(packet, packet.getPageIndices());
    for (const p of pages) doc.addPage(p);

    // Stamp the approver's (and treasurer's typed) marks onto the DELIVERY
    // COPY's form pages — the archived original stays untouched (hash-bound);
    // this copy is what existing print processes file. Field rects come from
    // the blank template (the archived packet is flattened, its fields gone;
    // geometry is identical). Form pages = ceil(active rows / 13).
    const approveRecord = records.find((r) => r.kind === "approve");
    if (approveRecord) {
      const approverIdentity = await prisma.signerIdentity.findUnique({
        where: { userId: approveRecord.signerUserId },
        select: { signatureImage: true },
      });
      const approvePayload = JSON.parse(approveRecord.payloadJson) as {
        ts?: number;
        signaturePlacement?: import("@/lib/esign/placement").SignaturePlacement;
      };
      const approvalDate = new Date(approvePayload.ts ?? approveRecord.createdAt.getTime());
      const dateString = `${String(approvalDate.getMonth() + 1).padStart(2, "0")}/${String(
        approvalDate.getDate()
      ).padStart(2, "0")}/${approvalDate.getFullYear()}`;

      const template = await PDFDocument.load(await loadTemplateBytes());
      const rectOf = (name: string) => {
        try {
          return template.getForm().getTextField(name).acroField.getWidgets()[0]?.getRectangle() ?? null;
        } catch {
          return null;
        }
      };
      const nameRect = rectOf("Approver Name");
      const dateRect = rectOf("Approval Date");
      const signaturePng = approverIdentity?.signatureImage?.startsWith("data:image/png;base64,")
        ? new Uint8Array(Buffer.from(approverIdentity.signatureImage.split(",")[1], "base64"))
        : null;
      // The approver's click-placed position (page-0 relative); fall back to
      // the signature-line anchor for older approvals with no recorded spot.
      const placement =
        approvePayload.signaturePlacement ??
        (await signatureAnchor(await loadTemplateBytes(), "approver"));

      const activeRows = claim.lineItems.filter((it) => !it.isExcluded).length;
      const formPageCount = Math.max(1, Math.ceil(activeRows / FORM_ROWS_PER_PAGE));
      // Cover page is index 0; packet form pages follow it. Name + date go on
      // every form page's "Approved by" fields; the drawn signature lands at
      // the approver's chosen spot on the first form page.
      for (let i = 1; i <= Math.min(formPageCount, pages.length); i++) {
        const page = doc.getPage(i);
        if (nameRect) {
          page.drawText(approveRecord.typedName || "", {
            x: nameRect.x + 2,
            y: nameRect.y + 3,
            size: 10,
            font: helv,
            color: rgb(0.1, 0.09, 0.08),
          });
        }
        if (dateRect) {
          page.drawText(dateString, {
            x: dateRect.x + 2,
            y: dateRect.y + 3,
            size: 10,
            font: helv,
            color: rgb(0.1, 0.09, 0.08),
          });
        }
        if (signaturePng && i === 1) {
          await stampSignatureAt(doc, page, signaturePng, placement);
        }
      }
    }

    const bytes = await doc.save();
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="approval-certificate-${id}.pdf"`,
      },
    });
  });
}
