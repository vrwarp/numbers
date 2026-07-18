import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { computeLineItemChanges, type ChangeSet } from "@/lib/audit";
import { mostCommonMinistryEvent } from "@/lib/ministries";
import { resolveSuggestedApprover } from "@/lib/positions-catalog";
import { APPROVER_PLUS_ROLES } from "@/lib/esign/types";

import { enqueueClaimEmbeddingDebounced, deleteEmbeddingsFor } from "@/lib/embeddings/queue";

export const runtime = "nodejs";

// Review-screen shape: line items grouped client-side by receipt. The PATCH
// below returns the same shape so the client can swap its state wholesale.
const REVIEW_INCLUDE = {
  lineItems: { orderBy: { sortOrder: "asc" as const } },
  receipts: {
    include: {
      receipt: {
        select: {
          id: true,
          originalName: true,
          mimeType: true,
          createdAt: true,
          note: true,
          merchant: true,
          purchaseDate: true,
          extractedTotalCents: true,
          extractedRefundCents: true,
        },
      },
    },
  },
};

/** Full claim detail for the review screen. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const reimbursement = await prisma.reimbursement.findFirst({
      where: { id, userId },
      include: REVIEW_INCLUDE,
    });
    if (!reimbursement) throw new ApiError(404, "Claim not found", "claimNotFound");
    // Pre-fill hint for the approver picker (Positions): only meaningful before
    // a decision, and only a suggestion — never assigns. Resolution is
    // fail-open (returns null on any miss), so the review screen never depends
    // on it.
    const suggested = ["draft", "generated", "rejected"].includes(reimbursement.status)
      ? await resolveSuggestedApprover(reimbursement)
      : null;
    return NextResponse.json({
      reimbursement: {
        ...reimbursement,
        approverInfo: await approverInfo(reimbursement.approverUserId),
        suggestedApproverUserId: suggested?.userId ?? null,
        suggestedApproverPosition: suggested?.positionName ?? null,
      },
    });
  });
}

/**
 * The assigned approver's routing availability, for the owner's waiting view
 * (A9/A10): "paused" = they stopped taking new requests (they can still
 * decide this one); "ineligible" = role or attested key gone, so an approval
 * can no longer bind and the owner should withdraw + reassign. Mirror state
 * for display — ledger validity and the decision route enforce the rules.
 */
async function approverInfo(approverUserId: string | null) {
  if (!approverUserId) return null;
  const approver = await prisma.user.findUnique({
    where: { id: approverUserId },
    select: {
      fullName: true,
      email: true,
      role: true,
      approvalsPaused: true,
      signerIdentity: { select: { status: true } },
    },
  });
  if (!approver) return null;
  const eligible =
    (APPROVER_PLUS_ROLES as readonly string[]).includes(approver.role) &&
    approver.signerIdentity?.status === "attested";
  return {
    name: approver.fullName || approver.email,
    availability: !eligible ? "ineligible" : approver.approvalsPaused ? "paused" : "available",
  };
}

const ClaimPatchSchema = z
  .object({
    singleMinistry: z.boolean(),
    claimMinistry: z.string().max(100),
    claimEvent: z.string().max(100),
    claimDescription: z.string().max(300),
  })
  .partial();

/**
 * Edit the claim-level review settings. In single-ministry mode the claim's
 * ministry/event MIRROR onto every non-excluded row (each fanned-out row is
 * un-verified — a content change always needs re-approval — and audit-logged
 * individually). Switching multi → single without an explicit claimMinistry
 * adopts the most common (ministry, event) pair among the active rows, the
 * same answer the UI's confirm dialog shows. Single mode is a convenience,
 * not a lock: rows can still be patched directly, and switching back to
 * multiple just stops the mirroring, leaving row values in place.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const parsed = ClaimPatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid claim update", "invalidClaimUpdate");
    const patch = parsed.data;

    const claim = await prisma.reimbursement.findFirst({
      where: { id, userId },
      include: { lineItems: true },
    });
    if (!claim) throw new ApiError(404, "Claim not found", "claimNotFound");
    if (claim.status !== "draft") {
      throw new ApiError(409, "Claim already generated; review settings are frozen", "claimSettingsFrozen");
    }

    const singleMinistry = patch.singleMinistry ?? claim.singleMinistry;
    const enablingSingle = singleMinistry && !claim.singleMinistry;

    // Multi → single with no explicit value: adopt what most rows already say.
    const adopted =
      enablingSingle && patch.claimMinistry === undefined
        ? mostCommonMinistryEvent(claim.lineItems)
        : null;
    const claimMinistry = patch.claimMinistry ?? adopted?.ministry ?? claim.claimMinistry;
    const claimEvent = patch.claimEvent ?? adopted?.event ?? claim.claimEvent;
    const claimDescription = patch.claimDescription ?? claim.claimDescription;

    // Mirror onto rows only when single mode is (still or newly) on and the
    // mirrored values were actually touched by this patch.
    const fanOut =
      singleMinistry &&
      (enablingSingle ||
        patch.claimMinistry !== undefined ||
        patch.claimEvent !== undefined ||
        adopted !== null);
    const rowWrites = fanOut
      ? claim.lineItems
          .filter(
            (it) => !it.isExcluded && (it.ministry !== claimMinistry || it.event !== claimEvent)
          )
          .map((it) => ({
            id: it.id,
            changes: computeLineItemChanges(it, {
              ministry: claimMinistry,
              event: claimEvent,
              // Content changed, so the human must re-approve the row.
              isVerified: false,
            }),
          }))
      : [];

    const claimChanges: ChangeSet = {};
    for (const field of ["singleMinistry", "claimMinistry", "claimEvent", "claimDescription"] as const) {
      const to = { singleMinistry, claimMinistry, claimEvent, claimDescription }[field];
      if (claim[field] !== to) claimChanges[field] = { from: claim[field], to };
    }

    await prisma.$transaction([
      prisma.reimbursement.update({
        where: { id },
        data: { singleMinistry, claimMinistry, claimEvent, claimDescription },
      }),
      ...rowWrites.map((w) =>
        prisma.lineItem.update({
          where: { id: w.id },
          data: { ministry: claimMinistry, event: claimEvent, isVerified: false },
        })
      ),
      // One audit event per changed row (same trail as a manual row edit),
      // plus one for the claim-level settings themselves.
      ...rowWrites
        .filter((w) => Object.keys(w.changes).length > 0)
        .map((w) =>
          prisma.auditEvent.create({
            data: {
              userId,
              reimbursementId: id,
              lineItemId: w.id,
              action: "update",
              detail: JSON.stringify({ changes: w.changes, source: "claim-ministry" }),
            },
          })
        ),
      ...(Object.keys(claimChanges).length > 0
        ? [
            prisma.auditEvent.create({
              data: {
                userId,
                reimbursementId: id,
                action: "update-claim",
                detail: JSON.stringify({ changes: claimChanges }),
              },
            }),
          ]
        : []),
    ]);

    // Draft content changed → debounced re-index (docs/SEARCH_DESIGN.md §5.2).
    enqueueClaimEmbeddingDebounced(id, userId);

    const reimbursement = await prisma.reimbursement.findFirst({
      where: { id, userId },
      include: REVIEW_INCLUDE,
    });
    return NextResponse.json({ reimbursement });
  });
}

/** Discard a draft claim; its receipts return to the Shoebox untouched. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const reimbursement = await prisma.reimbursement.findFirst({ where: { id, userId } });
    if (!reimbursement) throw new ApiError(404, "Claim not found", "claimNotFound");
    if (reimbursement.status !== "draft") throw new ApiError(409, "Only draft claims can be deleted", "onlyDraftDeletable");
    await prisma.reimbursement.delete({ where: { id } });
    await deleteEmbeddingsFor("claim", id);
    return NextResponse.json({ ok: true });
  });
}
