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
  requireRegistry,
  verifyReportedClaimEvent,
} from "@/lib/esign/server";
import type { MarkPaidAction, RawLedgerEventDoc } from "@/lib/esign/types";

export const runtime = "nodejs";

/**
 * Mark-paid ceremony (docs/ESIGN_DESIGN.md §5.5): treasurer role, approved
 * claims only. The payload latches the exact binding APPROVE (approveRef),
 * derived from the server's own evaluation — a payment can never reference
 * an approval that doesn't verify.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const registry = await requireRegistry();
    const preflight = new URL(req.url).searchParams.get("preflight") === "1";

    const me = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (me?.role !== "treasurer" && me?.role !== "admin") throw new ApiError(404, "Claim not found");
    const claim = await prisma.reimbursement.findUnique({ where: { id } });
    if (!claim) throw new ApiError(404, "Claim not found");
    if (claim.status !== "approved") {
      throw new ApiError(409, `Claim is ${claim.status}, not approved`);
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
      const body = (await req.json()) as { checkNumber?: string; typedName?: string };
      if (!body.typedName?.trim()) throw new ApiError(400, "Type your name to sign");
      const { evaluation } = await claimEvaluation(registry, ledgerCtx);
      const thread = evaluation.threads.find((t) => t.seq === claim.submitSeq);
      if (
        !thread ||
        thread.state !== "approved" ||
        !thread.decision ||
        thread.submit?.action.packetSha256 !== claim.packetSha256
      ) {
        throw new ApiError(
          409,
          "The ledger does not show a binding approval for these bytes — reconcile first"
        );
      }
      const payload: MarkPaidAction = {
        t: "MARK_PAID",
        v: 1,
        ledger: claim.signatureLedgerId,
        ts: Date.now(),
        claimId: id,
        packetSha256: claim.packetSha256,
        approveRef: thread.decision.actionHash,
        treasurerUid: userId,
        typedName: body.typedName.trim(),
        consentVersion: CONSENT_VERSION,
        consentSha256: await sha256Hex(CONSENT_TEXT),
        checkNumber: (body.checkNumber ?? "").slice(0, 40),
      };
      await setPendingAction(id, claim.pendingActionsJson, userId, payload);
      return NextResponse.json({ payload });
    }

    const body = (await req.json()) as Partial<RawLedgerEventDoc>;
    const pending = getPendingAction(claim, userId) as MarkPaidAction | null;
    if (!pending || pending.t !== "MARK_PAID") {
      throw new ApiError(409, "No pending payment ceremony — preflight first");
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
    await prisma.$transaction([
      prisma.reimbursement.update({
        where: { id },
        data: {
          status: "paid",
          paidAt: new Date(),
          checkNumber: pending.checkNumber,
          pendingActionsJson: JSON.stringify(cleared),
        },
      }),
      prisma.auditEvent.create({
        data: {
          userId,
          reimbursementId: id,
          action: "mark-paid",
          detail: JSON.stringify({
            packetSha256: claim.packetSha256,
            checkNumber: pending.checkNumber,
            eventId: event.eventId,
          }),
        },
      }),
    ]);
    await recordSignature(id, userId, event);
    return NextResponse.json({ ok: true, status: "paid" });
  });
}
