import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { requireEnabledRegistry } from "@/lib/esign/server";
import { claimSummary } from "@/lib/esign/claim-server";

export const runtime = "nodejs";

/**
 * Treasurer queue (docs/ESIGN_DESIGN.md §6.2): approved claims awaiting
 * payment plus the paid history, across all users — gated by the verified
 * role mirror (treasurer/admin), §6.3's third non-owner read grant. List
 * state is mirror-labeled; the mark-paid ceremony re-verifies client-side.
 */
export async function GET() {
  return handleApi(async () => {
    const userId = await requireUserId();
    await requireEnabledRegistry();
    const me = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (me?.role !== "treasurer" && me?.role !== "admin") throw new ApiError(404, "Not found");
    const claims = await prisma.reimbursement.findMany({
      where: { status: { in: ["approved", "paid"] } },
      include: { lineItems: true, user: { select: { fullName: true, email: true } } },
      orderBy: [{ status: "asc" }, { decidedAt: "desc" }],
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
