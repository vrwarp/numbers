import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { claimAccessRole } from "@/lib/esign/claim-server";
import { requireEsignAccess } from "@/lib/esign/server";
import { fieldAnchor, signatureAnchor } from "@/lib/pdf/generate";
import { loadTemplateBytes } from "@/lib/pdf/loadTemplate";

export const runtime = "nodejs";

/**
 * Default signature placement for the click-to-stamp UI
 * (docs/ESIGN_DESIGN.md click-to-stamp): derived from the template's
 * signature-line geometry so the draggable stamp seeds on the right line
 * and the signer just confirms. Owner gets the requestor line; the assigned
 * approver / treasurer get the approver line. `nameField`/`dateField` are the
 * printed-name and date rects on the same block, so the preview can show them
 * fill in exactly where the certificate route stamps them on signing.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    await requireEsignAccess(userId);
    const { id } = await ctx.params;
    const claim = await prisma.reimbursement.findUnique({ where: { id } });
    if (!claim) throw new ApiError(404, "Claim not found");
    const access = await claimAccessRole(claim, userId);
    const role = access === "owner" ? "requestor" : "approver";
    const templateBytes = await loadTemplateBytes();
    const anchor = await signatureAnchor(templateBytes, role);
    const [nameField, dateField] = await Promise.all([
      fieldAnchor(templateBytes, role === "requestor" ? "Requestor Name" : "Approver Name"),
      fieldAnchor(templateBytes, role === "requestor" ? "Request Date" : "Approval Date"),
    ]);
    return NextResponse.json({ anchor, nameField, dateField });
  });
}
