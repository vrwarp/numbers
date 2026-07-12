import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { canonicalStringify, sha256Hex } from "@/lib/esign/canonical";
import { CONSENT_TEXT, CONSENT_VERSION } from "@/lib/esign/consent";
import {
  getPendingAction,
  requireAttestedIdentity,
  setPendingAction,
} from "@/lib/esign/claim-server";
import {
  claimEvaluation,
  recordSignature,
  requireEsignAccess,
  verifyReportedClaimEvent,
} from "@/lib/esign/server";
import { roundPlacement, type SignaturePlacement } from "@/lib/esign/placement";
import type { ApproveAction, RawLedgerEventDoc, RejectAction } from "@/lib/esign/types";

export const runtime = "nodejs";

/**
 * Decision ceremony (docs/ESIGN_DESIGN.md §5.5) — the ASSIGNED approver only
 * (the treasurer queue has its own route; owners never decide their own
 * claims). Preflight derives submitRef from the server's own evaluation of
 * the mirrored ledger, so a decision can never float free of the exact
 * SUBMIT it answers.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const registry = await requireEsignAccess(userId);
    const preflight = new URL(req.url).searchParams.get("preflight") === "1";

    const claim = await prisma.reimbursement.findUnique({ where: { id } });
    // 404 (not 403) for anyone but the assigned approver — invariant 2.
    if (!claim || claim.approverUserId !== userId) throw new ApiError(404, "Claim not found");
    if (claim.status !== "submitted") {
      throw new ApiError(409, `Claim is ${claim.status}, not awaiting a decision`);
    }
    if (!claim.signatureLedgerId || !claim.signatureLedgerKey || !claim.packetSha256) {
      throw new ApiError(409, "Claim has no signature ledger on record");
    }
    const identity = await requireAttestedIdentity(userId);
    const ledgerCtx = {
      ledgerId: claim.signatureLedgerId,
      ledgerKey: claim.signatureLedgerKey,
      ownerUid: claim.userId,
      claimId: id,
    };

    if (preflight) {
      const body = (await req.json()) as {
        decision?: "approve" | "reject";
        comment?: string;
        typedName?: string;
        placement?: SignaturePlacement;
      };
      if (body.decision !== "approve" && body.decision !== "reject") {
        throw new ApiError(400, "decision must be approve or reject");
      }
      if (body.decision === "approve" && !body.typedName?.trim()) {
        throw new ApiError(400, "Type your name to sign an approval", "esign.typeNameApproval");
      }
      const { evaluation } = await claimEvaluation(registry, ledgerCtx);
      const thread = evaluation.threads.find((t) => t.seq === claim.submitSeq);
      if (
        !thread ||
        thread.state !== "open" ||
        !thread.submit ||
        thread.submit.action.packetSha256 !== claim.packetSha256 ||
        thread.submit.action.approverUid !== userId
      ) {
        throw new ApiError(
          409,
          "The ledger does not show an open submission naming you for these bytes — reconcile first"
        );
      }
      const base = {
        v: 1 as const,
        ledger: claim.signatureLedgerId,
        ts: Date.now(),
        claimId: id,
        packetSha256: claim.packetSha256,
        submitRef: thread.submit.actionHash,
        approverUid: userId,
        comment: (body.comment ?? "").slice(0, 500),
      };
      const payload: ApproveAction | RejectAction =
        body.decision === "approve"
          ? {
              ...base,
              t: "APPROVE",
              typedName: body.typedName!.trim(),
              consentVersion: CONSENT_VERSION,
              consentSha256: await sha256Hex(CONSENT_TEXT),
              ...(identity.signatureImage
                ? { signatureImageSha256: await sha256Hex(identity.signatureImage) }
                : {}),
              // Where the approver click-placed their signature (stamped onto
              // the certificate delivery copy; docs/ESIGN_DESIGN.md click-to-stamp).
              ...(identity.signatureImage.startsWith("data:image/png;base64,") && body.placement
                ? { signaturePlacement: roundPlacement(body.placement) }
                : {}),
            }
          : { ...base, t: "REJECT" };
      await setPendingAction(id, claim.pendingActionsJson, userId, payload);
      return NextResponse.json({ payload });
    }

    const body = (await req.json()) as Partial<RawLedgerEventDoc>;
    const pending = getPendingAction(claim, userId) as ApproveAction | RejectAction | null;
    if (!pending || (pending.t !== "APPROVE" && pending.t !== "REJECT")) {
      throw new ApiError(409, "No pending decision ceremony — preflight first");
    }
    const event = await verifyReportedClaimEvent(ledgerCtx, {
      eventId: body.eventId,
      createdAtMs: body.createdAtMs,
      encryptedData: body.encryptedData,
      iv: body.iv,
    });
    if (canonicalStringify(event.action) !== canonicalStringify(pending)) {
      throw new ApiError(409, "Reported event does not match the pinned ceremony payload");
    }
    if (event.signerPublicKey !== identity.publicKey) {
      throw new ApiError(409, "Event signed by a key that is not your attested identity");
    }

    const cleared = JSON.parse(claim.pendingActionsJson) as Record<string, unknown>;
    delete cleared[userId];
    const newStatus = pending.t === "APPROVE" ? "approved" : "rejected";
    await prisma.$transaction([
      prisma.reimbursement.update({
        where: { id },
        data: {
          status: newStatus,
          decidedAt: new Date(),
          pendingActionsJson: JSON.stringify(cleared),
        },
      }),
      prisma.auditEvent.create({
        data: {
          userId,
          reimbursementId: id,
          action: pending.t === "APPROVE" ? "approve" : "reject",
          detail: JSON.stringify({
            packetSha256: claim.packetSha256,
            comment: pending.comment,
            eventId: event.eventId,
          }),
        },
      }),
    ]);
    await recordSignature(id, userId, event);
    return NextResponse.json({ ok: true, status: newStatus });
  });
}
