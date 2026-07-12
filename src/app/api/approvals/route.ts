import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi } from "@/lib/api";
import { requireEsignAccess } from "@/lib/esign/server";
import { claimSummary } from "@/lib/esign/claim-server";

export const runtime = "nodejs";

/**
 * Approver inbox (docs/ESIGN_DESIGN.md §6.2): claims assigned to me. List
 * data is MIRROR state (labeled unverified in the UI); the detail/ceremony
 * views re-verify the chain client-side with the ledger key relayed here —
 * one of §6.3's deliberate non-owner read grants.
 */
export async function GET() {
  return handleApi(async () => {
    const userId = await requireUserId();
    await requireEsignAccess(userId);
    const claims = await prisma.reimbursement.findMany({
      where: {
        approverUserId: userId,
        status: { in: ["submitted", "approved", "rejected", "paid"] },
      },
      include: { lineItems: true, user: { select: { fullName: true, email: true } } },
      orderBy: { submittedAt: "desc" },
    });
    const items = await Promise.all(
      claims.map(async (claim) => ({
        ...claimSummary(claim, claim.user.fullName || claim.user.email),
        signatureLedgerKey: claim.signatureLedgerKey,
      }))
    );
    return NextResponse.json({ claims: items });
  });
}
