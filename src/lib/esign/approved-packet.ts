/**
 * Approved-copy derivation — SERVER ONLY (docs/ESIGN_DESIGN.md §5.1, the
 * three-tier packet model). Tier 2 is the hash-frozen packet archived at
 * submit; tier 3 (built here) is that exact packet with the approver's
 * ink/name/date stamped onto the "Approved by" block, plus a printed pointer
 * back to tier 2's SHA-256.
 *
 * Every stamped value comes from the APPROVE payload the approver is about
 * to sign (typedName, ts, signaturePlacement) or is pinned by it (the ink
 * PNG via signatureImageSha256) — so the copy is derived from signed data
 * only, archived write-once at preflight, and its own SHA-256 rides INSIDE
 * the signed payload as `approvedPacketSha256`. MARK_PAID pins it
 * transitively through approveRef.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { sha256Hex } from "./canonical";
import type { SignaturePlacement } from "./placement";
import { embedCjkFont } from "@/lib/pdf/fonts";
import { stampSignatureAt, toEncodableText } from "@/lib/pdf/generate";
import { loadTemplateBytes } from "@/lib/pdf/loadTemplate";
import { FORM_ROWS_PER_PAGE } from "@/lib/config";

/** The signing-time date the marks carry, matching the payload's `ts`. */
export function formatApprovalDate(tsMs: number): string {
  const d = new Date(tsMs);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

/** Decode a stored hand-drawn signature; null when absent or not a PNG. */
export function pngFromDataUrl(dataUrl: string | null | undefined): Uint8Array | null {
  if (!dataUrl?.startsWith("data:image/png;base64,")) return null;
  return new Uint8Array(Buffer.from(dataUrl.split(",")[1], "base64"));
}

export interface ApprovalMarks {
  typedName: string;
  dateString: string;
  signaturePng: Uint8Array | null;
  placement: SignaturePlacement;
}

/**
 * Stamp the approver's printed name + date onto the "Approved by" fields of
 * `formPageCount` form pages starting at `firstPageIndex`, and the drawn
 * signature (when one exists) at `placement` on the first of them. Field
 * rects come from the blank template — the archived packet is flattened, its
 * fields gone; the geometry is identical. Shared by the approved-copy
 * derivation and the certificate route's legacy (pre-feature) restamp path.
 */
export async function stampApprovalMarks(
  doc: PDFDocument,
  firstPageIndex: number,
  formPageCount: number,
  marks: ApprovalMarks
): Promise<void> {
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  let cjk: PDFFont | null = null;
  const template = await PDFDocument.load(await loadTemplateBytes());
  const fieldInfo = (name: string) => {
    try {
      const field = template.getForm().getTextField(name);
      const rect = field.acroField.getWidgets()[0]?.getRectangle();
      return rect ? { rect, quadding: field.acroField.getQuadding() ?? 0 } : null;
    } catch {
      return null; // customized template without the field
    }
  };
  const nameField = fieldInfo("Approver Name");
  const dateField = fieldInfo("Approval Date");

  // Match the flattened requestor fields: honor the field's own alignment
  // (the CFCC template centers these) and vertically center the glyph run in
  // the field box the way pdf-lib's field appearances do — a left-anchored
  // baseline reads visibly out of step next to the AcroForm-filled block.
  const drawInField = (
    page: ReturnType<PDFDocument["getPage"]>,
    text: string,
    font: PDFFont,
    size: number,
    info: NonNullable<ReturnType<typeof fieldInfo>>
  ) => {
    const w = font.widthOfTextAtSize(text, size);
    const x =
      info.quadding === 1
        ? info.rect.x + (info.rect.width - w) / 2
        : info.quadding === 2
          ? info.rect.x + info.rect.width - w - 2
          : info.rect.x + 2;
    const capHeight = font.heightAtSize(size, { descender: false });
    const y = info.rect.y + (info.rect.height - capHeight) / 2;
    page.drawText(text, { x, y, size, font, color: rgb(0.1, 0.09, 0.08) });
  };

  const last = Math.min(firstPageIndex + formPageCount, doc.getPageCount());
  for (let i = firstPageIndex; i < last; i++) {
    const page = doc.getPage(i);
    if (nameField && marks.typedName) {
      const nameFont =
        toEncodableText(marks.typedName, helv) === marks.typedName ? helv : (cjk ??= await embedCjkFont(doc));
      drawInField(page, toEncodableText(marks.typedName, nameFont), nameFont, 10, nameField);
    }
    if (dateField) {
      drawInField(page, marks.dateString, helv, 10, dateField);
    }
    if (marks.signaturePng && i === firstPageIndex) {
      await stampSignatureAt(doc, page, marks.signaturePng, marks.placement);
    }
  }
}

/**
 * Derive the approved copy from the archived packet bytes. Returns the new
 * bytes and their SHA-256 — the caller archives them write-once and embeds
 * the hash in the APPROVE payload before it is signed.
 */
export async function deriveApprovedPacket(input: {
  /** The archived tier-2 packet (requestor-signed, hash-frozen). */
  packetBytes: Buffer | Uint8Array;
  /** Tier 2's SHA-256, printed on the copy as the pointer to the original. */
  derivedFromSha256: string;
  /** Non-excluded line items — determines how many form pages get marks. */
  activeRowCount: number;
  marks: ApprovalMarks;
}): Promise<{ bytes: Uint8Array; sha256: string }> {
  const doc = await PDFDocument.load(
    input.packetBytes instanceof Buffer ? new Uint8Array(input.packetBytes) : input.packetBytes,
    { ignoreEncryption: true }
  );
  const formPageCount = Math.min(
    Math.max(1, Math.ceil(input.activeRowCount / FORM_ROWS_PER_PAGE)),
    doc.getPageCount()
  );
  await stampApprovalMarks(doc, 0, formPageCount, input.marks);

  // The printed pointer back to the untouched original: anyone holding this
  // copy can fetch/verify tier 2 by hash (also bound inside the APPROVE
  // payload next to this copy's own hash).
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  doc.getPage(0).drawText(
    `Approved copy - approver marks added at approval. Original signed packet SHA-256: ${input.derivedFromSha256}`,
    { x: 36, y: 7, size: 6.5, font: helv, color: rgb(0.45, 0.43, 0.4) }
  );

  const bytes = await doc.save();
  return { bytes, sha256: await sha256Hex(bytes) };
}
