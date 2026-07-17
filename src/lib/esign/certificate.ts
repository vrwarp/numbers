/**
 * Approval-certificate cover page (docs/ESIGN_DESIGN.md §7.1) — SERVER ONLY.
 * The signature blocks, hashes, root fingerprint, and verify QR that sit ahead
 * of the signed packet. Extracted so the single-claim certificate route and the
 * treasurer's batch-print composer draw an identical cover; the caller owns the
 * packet pages, the offline bundle attachment, and any legacy restamping.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import qrcode from "qrcode-generator";
import type { SignatureRecord } from "@prisma/client";
import { fingerprintDisplay, keyFingerprint } from "./canonical";
import { embedCjkFont } from "@/lib/pdf/fonts";
import { toEncodableText } from "@/lib/pdf/generate";

export interface CoverInput {
  claimId: string;
  ownerName: string;
  status: string;
  checkNumber: string | null;
  records: SignatureRecord[];
  signerNames: Map<string, string>;
  packetSha256: string;
  rootPublicKey: string;
  /** Deployment fingerprint pin (prefix), when configured. */
  rootPin?: string;
  publicToken: string | null;
  /** Deployment origin for the verify QR, when configured. */
  baseUrl?: string;
}

/** Append the certificate cover as a new page on `doc`. */
export async function drawCertificateCover(doc: PDFDocument, input: CoverInput): Promise<void> {
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  // Names, typed signatures, and comments are user data — Chinese values
  // outgrow WinAnsi, so each string picks Helvetica or the CJK face
  // (invariant #8; same per-string strategy as the form fill).
  let cjk: PDFFont | null = null;
  const cjkFont = async () => (cjk ??= await embedCjkFont(doc));
  const page = doc.addPage([612, 792]);
  let y = 740;
  const text = async (
    s: string,
    opts: { size?: number; bold?: boolean; x?: number; color?: [number, number, number] } = {}
  ) => {
    let font = opts.bold ? helvBold : helv;
    if (toEncodableText(s, font) !== s) font = await cjkFont();
    page.drawText(toEncodableText(s, font), {
      x: opts.x ?? 56,
      y,
      size: opts.size ?? 10,
      font,
      color: opts.color ? rgb(...opts.color) : rgb(0.1, 0.09, 0.08),
    });
    y -= (opts.size ?? 10) + 6;
  };

  await text("Reimbursement Approval Certificate", { size: 18, bold: true });
  await text("Chinese For Christ Church of Hayward — electronic signature record", {
    size: 9,
    color: [0.4, 0.38, 0.35],
  });
  y -= 8;
  await text(`Requested by: ${input.ownerName}`, { size: 11 });
  await text(`Claim: ${input.claimId}`, { size: 9, color: [0.4, 0.38, 0.35] });
  await text(
    `Status: ${input.status.toUpperCase()}${input.checkNumber ? `  ·  Check #${input.checkNumber}` : ""}`,
    { size: 11, bold: true }
  );
  y -= 6;

  for (const record of input.records) {
    const payload = JSON.parse(record.payloadJson) as {
      ts?: number;
      consentVersion?: string;
      comment?: string;
    };
    const fp = fingerprintDisplay(await keyFingerprint(record.signerPublicKey));
    const when = payload.ts ? new Date(payload.ts).toISOString() : record.createdAt.toISOString();
    await text(
      `${record.kind.toUpperCase()} — ${input.signerNames.get(record.signerUserId) ?? "unknown"}`,
      { size: 12, bold: true }
    );
    if (record.typedName) await text(`Signed name: "${record.typedName}"`, { size: 10 });
    await text(`Time (signer clock): ${when}    Consent: ${payload.consentVersion ?? "—"}`, {
      size: 9,
      color: [0.35, 0.33, 0.3],
    });
    await text(`Key fingerprint: ${fp}    Event: ${record.ledgerEventId}`, {
      size: 9,
      color: [0.35, 0.33, 0.3],
    });
    if (payload.comment) await text(`Comment: "${payload.comment}"`, { size: 9 });
    y -= 4;
  }

  y -= 4;
  await text(`Packet SHA-256: ${input.packetSha256}`, { size: 8, color: [0.35, 0.33, 0.3] });
  const rootFp = await keyFingerprint(input.rootPublicKey);
  await text(`Church root fingerprint: ${rootFp}`, { size: 8, color: [0.35, 0.33, 0.3] });
  await text("Compare the root fingerprint against the value your church published.", {
    size: 8,
    color: [0.5, 0.35, 0.1],
  });
  if (input.rootPin) await text(`Deployment pin (prefix): ${input.rootPin}`, { size: 8, color: [0.35, 0.33, 0.3] });
  y -= 6;
  await text(
    "The pages after this cover are the signed packet, with the approval signature stamped on",
    { size: 8, color: [0.4, 0.38, 0.35] }
  );
  await text(
    "for filing. The untouched original is archived and one QR scan away; this PDF also embeds",
    { size: 8, color: [0.4, 0.38, 0.35] }
  );
  await text(
    "verification-bundle.json — verify offline with scripts/verify-bundle.mjs and the root fingerprint.",
    { size: 8, color: [0.4, 0.38, 0.35] }
  );

  // QR to the live verification page, when the deployment knows its origin.
  if (input.baseUrl && input.publicToken) {
    const qr = qrcode(0, "M");
    qr.addData(`${input.baseUrl}/v/${input.publicToken}`);
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
}
