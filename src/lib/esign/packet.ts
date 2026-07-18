/**
 * Shared claim-packet assembly (SERVER ONLY) — the single place that turns a
 * claim's rows + receipts into the CFCC PDF, used by BOTH the `/pdf`
 * generation route (unsigned) and the submit ceremony (with the requestor's
 * click-placed signature baked in, docs/ESIGN_DESIGN.md click-to-stamp).
 */

import type { LineItem, Receipt, ReimbursementReceipt } from "@prisma/client";
import { readStoredFile } from "@/lib/storage";
import { generateClaimPdf } from "@/lib/pdf/generate";
import { loadTemplateForRows } from "@/lib/pdf/loadTemplate";
import { formatMinistryEvent } from "@/lib/ministries";
import { publicBaseUrl } from "@/lib/config";
import type { SignaturePlacement } from "@/lib/esign/placement";

type ClaimForPacket = {
  lineItems: LineItem[];
  receipts: (ReimbursementReceipt & { receipt: Receipt })[];
  user: { fullName: string | null; mailingAddress: string | null; email: string };
};

export async function buildClaimPdfBytes(
  claim: ClaimForPacket,
  publicToken: string,
  opts: { requestorSignature?: { png: Uint8Array; placement: SignaturePlacement } } = {}
): Promise<Uint8Array> {
  const active = claim.lineItems.filter((it) => !it.isExcluded);
  const activeReceiptIds = new Set(active.map((it) => it.receiptId));
  const includedReceipts = claim.receipts.filter((rr) => activeReceiptIds.has(rr.receiptId));

  const receiptFiles = [];
  for (const rr of includedReceipts) {
    receiptFiles.push({
      data: await readStoredFile(rr.receipt.filePath),
      mimeType: rr.receipt.mimeType,
      originalName: rr.receipt.originalName,
      note: rr.receipt.note,
    });
  }

  const now = new Date();
  const dateString = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(
    now.getDate()
  ).padStart(2, "0")}/${now.getFullYear()}`;
  const base = publicBaseUrl();
  // Small claims fill the large-row legibility variant they fit on; the
  // choice never changes the packet's form-page count (see variantRowsFor).
  const template = await loadTemplateForRows(active.length);

  return generateClaimPdf({
    requesterName: claim.user.fullName || claim.user.email,
    requesterAddress: claim.user.mailingAddress || "",
    dateString,
    items: active
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((it) => ({
        description: it.description,
        amountCents: it.amountCents,
        ministry: formatMinistryEvent(it.ministry, it.event),
      })),
    receipts: receiptFiles,
    templateBytes: template.bytes,
    rowsPerPage: template.rowsPerPage,
    selfLinkUrl: base ? `${base}/c/${publicToken}` : undefined,
    requestorSignature: opts.requestorSignature,
  });
}
