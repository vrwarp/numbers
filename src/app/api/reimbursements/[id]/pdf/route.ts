import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { readStoredFile } from "@/lib/storage";
import { generateClaimPdf } from "@/lib/pdf/generate";
import { loadTemplateBytes } from "@/lib/pdf/loadTemplate";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Generate the final reimbursement packet PDF. Refuses unless every
 * non-excluded row has been explicitly verified (the human-in-the-loop rule).
 * On success the claim is marked "generated" and its receipts "processed".
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;

    const reimbursement = await prisma.reimbursement.findFirst({
      where: { id, userId },
      include: {
        lineItems: { orderBy: { sortOrder: "asc" } },
        receipts: { include: { receipt: true } },
        user: { select: { fullName: true, mailingAddress: true, email: true } },
      },
    });
    if (!reimbursement) throw new ApiError(404, "Claim not found");

    const active = reimbursement.lineItems.filter((it) => !it.isExcluded);
    if (active.length === 0) throw new ApiError(400, "Claim has no line items to reimburse");
    const unverified = active.filter((it) => !it.isVerified);
    if (unverified.length > 0) {
      throw new ApiError(400, `${unverified.length} row(s) still need verification before the PDF can be generated`);
    }
    // Defense in depth: verifying already requires a ministry, but the PDF is
    // the real gate — never print a row without an explicit ministry choice.
    const missingMinistry = active.filter((it) => !it.ministry);
    if (missingMinistry.length > 0) {
      throw new ApiError(400, `${missingMinistry.length} row(s) still need a ministry before the PDF can be generated`);
    }

    // A receipt whose every row is excluded backs nothing on the form —
    // leave its image out of the packet so the treasurer never gets a
    // receipt page with no matching claim row.
    const activeReceiptIds = new Set(active.map((it) => it.receiptId));
    const includedReceipts = reimbursement.receipts.filter((rr) =>
      activeReceiptIds.has(rr.receiptId)
    );
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
    const dateString = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear()}`;

    const pdfBytes = await generateClaimPdf({
      requesterName: reimbursement.user.fullName || reimbursement.user.email,
      requesterAddress: reimbursement.user.mailingAddress || "",
      dateString,
      items: active.map((it) => ({
        description: it.description,
        amountCents: it.amountCents,
        ministry: it.ministry,
      })),
      receipts: receiptFiles,
      templateBytes: await loadTemplateBytes(),
    });

    const totalCents = active.reduce((s, it) => s + it.amountCents, 0);
    await prisma.$transaction([
      prisma.reimbursement.update({ where: { id }, data: { status: "generated", totalCents } }),
      prisma.receipt.updateMany({
        where: { id: { in: reimbursement.receipts.map((rr) => rr.receiptId) } },
        data: { status: "processed" },
      }),
    ]);

    return new NextResponse(new Uint8Array(pdfBytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="cfcc-reimbursement-${id}.pdf"`,
      },
    });
  });
}
