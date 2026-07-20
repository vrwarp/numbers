import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi } from "@/lib/api";
import { requireEsignAccess } from "@/lib/esign/server";
import { APPROVER_PLUS_ROLES } from "@/lib/esign/types";
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
    // The inbox's own-eligibility context (A9/A10): paused shows a notice on
    // grandfathered claims; a lost role disables Approve (Reject stays — a
    // demoted approver hands claims back). Mirror state, enforced server-side
    // in the decision route and by ledger validity regardless.
    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, approvalsPaused: true, signerIdentity: { select: { status: true } } },
    });
    return NextResponse.json({
      claims: items,
      me: {
        approvalsPaused: me?.approvalsPaused ?? false,
        canApprove: (APPROVER_PLUS_ROLES as readonly string[]).includes(me?.role ?? ""),
        // Backstop empty-state branches (docs/ESIGN_SETUP_DISCOVERABILITY.md
        // §3.8): a role-holder in a transitional identity state (re-enrolling,
        // revoked) sees WHY the inbox is dark instead of a bare dove.
        identityStatus: me?.signerIdentity?.status ?? null,
      },
    });
  });
}
