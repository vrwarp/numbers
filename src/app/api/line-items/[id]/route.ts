import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { computeLineItemChanges } from "@/lib/audit";

import { enqueueClaimEmbeddingDebounced } from "@/lib/embeddings/queue";

export const runtime = "nodejs";

const PatchSchema = z
  .object({
    description: z.string().min(1).max(300),
    amountCents: z.number().int(),
    ministry: z.string().max(100),
    event: z.string().max(100),
    isVerified: z.boolean(),
    isExcluded: z.boolean(),
  })
  .partial();

/**
 * Edit a line item during review (verify, exclude, adjust tax/amount, change
 * ministry, ...). Any content change un-verifies the row so the human must
 * re-approve it. The claim's total is recomputed on every change.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid line item update", "invalidLineItemUpdate");
    const patch = parsed.data;

    const item = await prisma.lineItem.findFirst({
      where: { id, reimbursement: { userId } },
      include: {
        reimbursement: {
          select: { status: true, id: true, singleMinistry: true, claimMinistry: true, claimEvent: true },
        },
      },
    });
    if (!item) throw new ApiError(404, "Line item not found", "lineItemNotFound");
    if (item.reimbursement.status !== "draft") {
      throw new ApiError(409, "Claim already generated; line items are frozen", "claimFrozen");
    }
    // A row restored in single-ministry mode missed any fan-out that happened
    // while it was excluded — stamp it back to the claim's ministry/event.
    // This must run BEFORE the verify gate: restore + verify in one PATCH is
    // legitimate, and the stamped ministry is what satisfies the gate.
    if (patch.isExcluded === false && item.isExcluded && item.reimbursement.singleMinistry) {
      if (patch.ministry === undefined) patch.ministry = item.reimbursement.claimMinistry;
      if (patch.event === undefined) patch.event = item.reimbursement.claimEvent;
    }
    // Verification is an explicit human sign-off, and the ministry is part of
    // it — the AI never assigns one, so the user must choose before approving.
    // Trim so a whitespace-only ministry (" ") can't satisfy the gate and then
    // print as a blank column on the official form.
    const effectiveMinistry = (patch.ministry ?? item.ministry).trim();
    if (patch.isVerified === true && !effectiveMinistry) {
      throw new ApiError(400, "Choose a ministry before verifying this row", "ministryRequiredToVerify");
    }

    const changes = computeLineItemChanges(item, patch);
    const contentChanged = ["description", "amountCents", "ministry", "event"].some(
      (f) => f in changes
    );
    // Fold the implicit re-verification revocation into the patch so the audit
    // trail records the isVerified true→false flip that a content edit triggers
    // (invariant 4), instead of a content change with no verification change.
    if (contentChanged && patch.isVerified === undefined && item.isVerified) {
      patch.isVerified = false;
      Object.assign(changes, computeLineItemChanges(item, { isVerified: false }));
    }

    const updated = await prisma.lineItem.update({
      where: { id },
      data: patch,
    });

    // Record what the human changed — the counterpart to the AI extraction log.
    if (Object.keys(changes).length > 0) {
      await prisma.auditEvent.create({
        data: {
          userId,
          reimbursementId: item.reimbursement.id,
          lineItemId: id,
          action: "update",
          detail: JSON.stringify({ changes }),
        },
      });
    }

    const items = await prisma.lineItem.findMany({ where: { reimbursementId: item.reimbursement.id } });
    const totalCents = items.reduce((s, it) => (it.isExcluded ? s : s + it.amountCents), 0);
    await prisma.reimbursement.update({ where: { id: item.reimbursement.id }, data: { totalCents } });

    enqueueClaimEmbeddingDebounced(item.reimbursement.id, userId);
    return NextResponse.json({ lineItem: updated, totalCents });
  });
}
