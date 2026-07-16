import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { canonicalStringify, sha256Hex } from "@/lib/esign/canonical";
import { CONSENT_TEXT, CONSENT_VERSION } from "@/lib/esign/consent";
import {
  archiveSignedPacket,
  getPendingAction,
  requireAttestedIdentity,
  setPendingAction,
  signedPacketPath,
} from "@/lib/esign/claim-server";
import {
  claimEvaluation,
  recordSignature,
  requireEsignAccess,
  verifyReportedClaimEvent,
} from "@/lib/esign/server";
import {
  deriveApprovedPacket,
  formatApprovalDate,
  pngFromDataUrl,
} from "@/lib/esign/approved-packet";
import { roundPlacement, type SignaturePlacement } from "@/lib/esign/placement";
import { readStoredFile } from "@/lib/storage";
import { signatureAnchor } from "@/lib/pdf/generate";
import { loadTemplateBytes } from "@/lib/pdf/loadTemplate";
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
      // Role-at-exercise (A9): an APPROVE binds only while the signer still
      // holds approver-or-above — mirror check here for a friendly early
      // error; the ledger rule (validity.ts) is what actually enforces it.
      // REJECT stays open to a demoted approver (hand the claim back), and a
      // PAUSED approver (A10) may still decide claims already assigned to
      // them — pausing only stops new submissions naming them.
      if (body.decision === "approve") {
        const me = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
        if (!["approver", "treasurer", "admin"].includes(me?.role ?? "")) {
          throw new ApiError(
            409,
            "Your approver role has been removed — you can decline, but not approve",
            "esign.approverRoleLost"
          );
        }
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
      let payload: ApproveAction | RejectAction;
      if (body.decision === "approve") {
        const approve: ApproveAction = {
          ...base,
          t: "APPROVE",
          typedName: body.typedName!.trim(),
          consentVersion: CONSENT_VERSION,
          consentSha256: await sha256Hex(CONSENT_TEXT),
          ...(identity.signatureImage
            ? { signatureImageSha256: await sha256Hex(identity.signatureImage) }
            : {}),
          // Where the approver click-placed their signature (stamped onto
          // the approved copy; docs/ESIGN_DESIGN.md click-to-stamp).
          ...(identity.signatureImage.startsWith("data:image/png;base64,") && body.placement
            ? { signaturePlacement: roundPlacement(body.placement) }
            : {}),
        };
        // Derive the approved copy (tier 3) from the archived packet and the
        // exact fields of the payload the approver is about to sign, archive
        // it write-once, and bind its hash INTO that payload — the commit's
        // canonical-equality check then guarantees the signature covers it.
        const packetBytes = await readStoredFile(
          signedPacketPath(claim.userId, id, claim.packetSha256)
        ).catch(() => {
          throw new ApiError(409, "Archived packet bytes are missing — cannot derive the approved copy");
        });
        const activeRowCount = await prisma.lineItem.count({
          where: { reimbursementId: id, isExcluded: false },
        });
        const derived = await deriveApprovedPacket({
          packetBytes,
          derivedFromSha256: claim.packetSha256,
          activeRowCount,
          marks: {
            typedName: approve.typedName,
            dateString: formatApprovalDate(approve.ts),
            signaturePng: pngFromDataUrl(identity.signatureImage),
            placement:
              approve.signaturePlacement ??
              (await signatureAnchor(await loadTemplateBytes(), "approver")),
          },
        });
        await archiveSignedPacket(claim.userId, id, derived.sha256, Buffer.from(derived.bytes));
        payload = { ...approve, approvedPacketSha256: derived.sha256 };
      } else {
        payload = { ...base, t: "REJECT" };
      }
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
    // Believe the ledger, not the pin (A9): the event is mirrored above, so
    // re-evaluate and flip status only if THIS event is the thread's binding
    // decision. Closes the preflight→append race — a REVOKE_ROLE reported in
    // between voids the APPROVE on the ledger, and the mirror must not say
    // otherwise. The raw event stays mirrored either way (it is ledger fact,
    // surfaced as an anomaly by every verifying view).
    const { evaluation } = await claimEvaluation(registry, ledgerCtx);
    const thread = evaluation.threads.find((t) => t.seq === claim.submitSeq);
    if (thread?.decision?.actionHash !== event.actionHash) {
      throw new ApiError(
        409,
        "The reported decision does not bind on the ledger (was your approver role revoked?) — reconcile the claim",
        "esign.decisionNotBinding"
      );
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
          // Mirror the approved copy's hash from the signature-verified
          // payload (event === pinned payload was checked above).
          ...(pending.t === "APPROVE" && pending.approvedPacketSha256
            ? { approvedPacketSha256: pending.approvedPacketSha256 }
            : {}),
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
