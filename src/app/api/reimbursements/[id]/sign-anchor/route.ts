import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { claimAccessRole } from "@/lib/esign/claim-server";
import { requireEnabledRegistry } from "@/lib/esign/server";
import { signatureAnchor } from "@/lib/pdf/generate";
import { loadTemplateBytes } from "@/lib/pdf/loadTemplate";

export const runtime = "nodejs";

/**
 * Default signature placement for the click-to-stamp UI
 * (docs/ESIGN_DESIGN.md click-to-stamp): derived from the template's
 * signature-line geometry so the draggable stamp seeds on the right line
 * and the signer just confirms. Owner gets the requestor line; the assigned
 * approver / treasurer get the approver line.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    await requireEnabledRegistry();
    const { id } = await ctx.params;
    const claim = await prisma.reimbursement.findUnique({ where: { id } });
    if (!claim) throw new ApiError(404, "Claim not found");
    const access = await claimAccessRole(claim, userId);
    const role = access === "owner" ? "requestor" : "approver";
    const anchor = await signatureAnchor(await loadTemplateBytes(), role);
    return NextResponse.json({ anchor });
  });
}
