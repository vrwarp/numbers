import crypto from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { saveGeneratedPdf } from "@/lib/storage";
import { buildClaimPdfBytes } from "@/lib/esign/packet";

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
    if (!reimbursement) throw new ApiError(404, "Claim not found", "claimNotFound");
    // Hash-bound signatures reference the archived bytes: while a claim is
    // under signature the packet is frozen — regeneration is only reachable
    // through revert, which voids the signatures (docs/ESIGN_DESIGN.md §5.1).
    if (["submitted", "rejected", "approved", "paid"].includes(reimbursement.status)) {
      throw new ApiError(
        409,
        "The packet is frozen under signature — download it from the claim page, or revert to draft to edit"
      );
    }

    const active = reimbursement.lineItems.filter((it) => !it.isExcluded);
    if (active.length === 0) throw new ApiError(400, "Claim has no line items to reimburse", "claimEmpty");
    const unverified = active.filter((it) => !it.isVerified);
    if (unverified.length > 0) {
      throw new ApiError(400, `${unverified.length} row(s) still need verification before the PDF can be generated`, "rowsUnverified", { count: unverified.length });
    }
    // Defense in depth: verifying already requires a ministry, but the PDF is
    // the real gate — never print a row without an explicit ministry choice.
    const missingMinistry = active.filter((it) => !it.ministry);
    if (missingMinistry.length > 0) {
      throw new ApiError(400, `${missingMinistry.length} row(s) still need a ministry before the PDF can be generated`, "rowsMissingMinistry", { count: missingMinistry.length });
    }

    // Mint the capability token on first generation; it survives revert /
    // re-generate cycles so a QR printed from any version keeps resolving to
    // the latest packet. 24 random bytes (base64url) — unguessable, and NOT
    // derived from the claim id.
    const publicToken =
      reimbursement.publicToken ?? crypto.randomBytes(24).toString("base64url");

    // Generation produces the UNSIGNED form (blank signature lines) — the base
    // for print-and-wet-sign AND for e-sign. The requestor's signature is
    // click-placed and baked in during the submit ceremony, not here
    // (docs/ESIGN_DESIGN.md click-to-stamp).
    const pdfBytes = await buildClaimPdfBytes(reimbursement, publicToken);

    // Persist the packet so /c/<token> can serve it later; overwriting on
    // every generation keeps the link pointed at the latest version.
    await saveGeneratedPdf(userId, id, pdfBytes);

    const totalCents = active.reduce((s, it) => s + it.amountCents, 0);
    await prisma.$transaction([
      prisma.reimbursement.update({
        where: { id },
        data: { status: "generated", totalCents, publicToken },
      }),
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
