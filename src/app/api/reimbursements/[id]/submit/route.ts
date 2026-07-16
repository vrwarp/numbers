import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { readStoredFile, saveGeneratedPdf, generatedPdfPath } from "@/lib/storage";
import { canonicalStringify, sha256Hex } from "@/lib/esign/canonical";
import { CONSENT_TEXT, CONSENT_VERSION } from "@/lib/esign/consent";
import {
  archiveSignedPacket,
  getPendingAction,
  requireAttestedIdentity,
  rowsDigestAndTotal,
  setPendingAction,
} from "@/lib/esign/claim-server";
import {
  claimEvaluation,
  recordSignature,
  requireEsignAccess,
  verifyReportedClaimEvent,
} from "@/lib/esign/server";
import { closureRefs } from "@/lib/esign/validity";
import { buildClaimPdfBytes } from "@/lib/esign/packet";
import { roundPlacement, type SignaturePlacement } from "@/lib/esign/placement";
import type { RawLedgerEventDoc, SubmitAction } from "@/lib/esign/types";

export const runtime = "nodejs";

const LEDGER_ID = /^[A-Za-z0-9_-]{8,64}$/;
const B64_KEY = /^[A-Za-z0-9+/=]{40,100}$/;

/**
 * Submission ceremony (docs/ESIGN_DESIGN.md §5.5): preflight pins the exact
 * canonical SUBMIT payload (server stamps seq/closesRef/ts so retries are
 * byte-identical); the full call verifies the reported envelope against the
 * pin, hash-checks and archives the packet bytes atomically with the status
 * flip, and records the mirror rows. Guards: owner only; status
 * generated∣submitted∣rejected (resubmission from `submitted` is the
 * stalled-approver escape — it requires a WITHDRAW to have closed the open
 * thread, which the closesRef derivation enforces).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const registry = await requireEsignAccess(userId);
    const preflight = new URL(req.url).searchParams.get("preflight") === "1";

    const claim = await prisma.reimbursement.findFirst({
      where: { id, userId },
      include: {
        lineItems: true,
        receipts: { include: { receipt: true } },
        user: { select: { fullName: true, mailingAddress: true, email: true } },
      },
    });
    if (!claim) throw new ApiError(404, "Claim not found");
    if (!["generated", "submitted", "rejected"].includes(claim.status)) {
      throw new ApiError(409, `Cannot submit a ${claim.status} claim`);
    }
    const identity = await requireAttestedIdentity(userId);

    if (preflight) {
      const body = (await req.json()) as {
        approverUserId?: string;
        typedName?: string;
        ledgerId?: string;
        placement?: SignaturePlacement;
      };
      if (!body.approverUserId || !body.typedName?.trim()) {
        throw new ApiError(400, "Pick an approver and type your name", "esign.pickApprover");
      }
      if (body.approverUserId === userId) {
        throw new ApiError(409, "You cannot approve your own claim", "esign.selfApprove");
      }
      const approver = await prisma.signerIdentity.findUnique({
        where: { userId: body.approverUserId },
        include: { user: { select: { role: true, approvalsPaused: true } } },
      });
      if (
        !approver ||
        approver.status !== "attested" ||
        !["approver", "treasurer", "admin"].includes(approver.user.role)
      ) {
        throw new ApiError(409, "That member is not an attested approver", "esign.notApprover");
      }
      // Duty pause (A10): a paused approver takes no NEW submissions. The
      // picker already hides them — this is the authoritative check behind it
      // (stale picker lists, races, or hand-crafted requests all land here).
      if (approver.user.approvalsPaused) {
        throw new ApiError(
          409,
          "That approver is not taking new approval requests right now",
          "esign.approverUnavailable"
        );
      }

      const ledgerId = claim.signatureLedgerId ?? body.ledgerId;
      if (!ledgerId || !LEDGER_ID.test(ledgerId)) {
        throw new ApiError(400, "Missing signature ledger id");
      }

      // Click-to-stamp: bake the requestor's signature into the packet at the
      // placement they chose, then hash THOSE bytes (docs/ESIGN_DESIGN.md
      // click-to-stamp). The placement is inside the frozen bytes AND signed
      // into the payload below. A signer with no drawn signature (edge case)
      // submits an unsigned form.
      let placement: SignaturePlacement | undefined;
      if (claim.publicToken && identity.signatureImage.startsWith("data:image/png;base64,")) {
        if (!body.placement) throw new ApiError(400, "Place your signature on the form first", "esign.placeSignature");
        placement = roundPlacement(body.placement);
        const png = new Uint8Array(Buffer.from(identity.signatureImage.split(",")[1], "base64"));
        const signedBytes = await buildClaimPdfBytes(claim, claim.publicToken, {
          requestorSignature: { png, placement },
        });
        await saveGeneratedPdf(userId, id, signedBytes);
      }

      const bytes = await readStoredFile(generatedPdfPath(userId, id)).catch(() => {
        throw new ApiError(409, "Generate the packet PDF before submitting", "esign.generateFirst");
      });
      const packetSha256 = await sha256Hex(new Uint8Array(bytes));
      const { rowsDigest, totalCents } = await rowsDigestAndTotal(claim.lineItems);

      const seq = claim.submitSeq + 1;
      let closesRef: string[] | null = null;
      if (seq > 1) {
        if (!claim.signatureLedgerId || !claim.signatureLedgerKey) {
          throw new ApiError(409, "Claim has prior submissions but no ledger on record");
        }
        const { evaluation } = await claimEvaluation(registry, {
          ledgerId: claim.signatureLedgerId,
          ledgerKey: claim.signatureLedgerKey,
          ownerUid: userId,
          claimId: id,
        });
        const prev = evaluation.threads.find((t) => t.seq === seq - 1);
        if (!prev) {
          throw new ApiError(409, "Ledger mirror is behind — reconcile this claim first", "esign.mirrorBehind");
        }
        const closure = closureRefs(prev, packetSha256);
        if (!closure) {
          throw new ApiError(
            409,
            prev.state === "open"
              ? "Withdraw the open submission before resubmitting"
              : "The previous submission is not closable with these bytes — edit and regenerate first"
          );
        }
        closesRef = [...closure];
      }

      const payload: SubmitAction = {
        t: "SUBMIT",
        v: 1,
        ledger: ledgerId,
        ts: Date.now(),
        seq,
        closesRef,
        claimId: id,
        packetSha256,
        rowsDigest,
        totalCents,
        requestorUid: userId,
        approverUid: body.approverUserId,
        typedName: body.typedName.trim(),
        consentVersion: CONSENT_VERSION,
        consentSha256: await sha256Hex(CONSENT_TEXT),
        ...(identity.signatureImage
          ? { signatureImageSha256: await sha256Hex(identity.signatureImage) }
          : {}),
        ...(placement ? { signaturePlacement: placement } : {}),
      };
      await setPendingAction(id, claim.pendingActionsJson, userId, payload);
      return NextResponse.json({ payload, needLedgerKey: !claim.signatureLedgerKey });
    }

    // --- Full call: verify the reported envelope against the pin -------------
    const body = (await req.json()) as Partial<RawLedgerEventDoc> & { ledgerKey?: string };
    const pending = getPendingAction(claim, userId) as SubmitAction | null;
    if (!pending || pending.t !== "SUBMIT") {
      throw new ApiError(409, "No pending submission ceremony — preflight first");
    }
    const ledgerKey = claim.signatureLedgerKey ?? body.ledgerKey;
    if (!ledgerKey || !B64_KEY.test(ledgerKey)) throw new ApiError(400, "Missing ledger key");

    const event = await verifyReportedClaimEvent(
      { ledgerId: pending.ledger, ledgerKey, ownerUid: userId, claimId: id },
      { eventId: body.eventId, createdAtMs: body.createdAtMs, encryptedData: body.encryptedData, iv: body.iv }
    );
    if (canonicalStringify(event.action) !== canonicalStringify(pending)) {
      throw new ApiError(409, "Reported event does not match the pinned ceremony payload");
    }
    if (event.signerPublicKey !== identity.publicKey) {
      throw new ApiError(409, "Event signed by a key that is not your attested identity");
    }

    // Hash-check and archive the SAME bytes, then flip status in one
    // transaction — no read-check-copy window for a concurrent regeneration.
    const bytes = await readStoredFile(generatedPdfPath(userId, id));
    const actualSha = await sha256Hex(new Uint8Array(bytes));
    if (actualSha !== pending.packetSha256) {
      throw new ApiError(409, "The packet changed since preflight — restart the ceremony", "esign.packetChanged");
    }
    await archiveSignedPacket(userId, id, actualSha, bytes);
    await prisma.esignClaimArchive.upsert({
      where: { claimId: id },
      create: {
        claimId: id,
        userId,
        ledgerId: pending.ledger,
        ledgerKey,
        publicToken: claim.publicToken ?? "",
      },
      update: {},
    });

    const cleared = JSON.parse(claim.pendingActionsJson) as Record<string, unknown>;
    delete cleared[userId];
    await prisma.$transaction([
      prisma.reimbursement.update({
        where: { id },
        data: {
          status: "submitted",
          approverUserId: pending.approverUid,
          signatureLedgerId: pending.ledger,
          signatureLedgerKey: ledgerKey,
          packetSha256: pending.packetSha256,
          submitSeq: pending.seq,
          submittedAt: new Date(),
          decidedAt: null,
          pendingActionsJson: JSON.stringify(cleared),
        },
      }),
      prisma.auditEvent.create({
        data: {
          userId,
          reimbursementId: id,
          action: "submit",
          detail: JSON.stringify({
            seq: pending.seq,
            approverUserId: pending.approverUid,
            packetSha256: pending.packetSha256,
            eventId: event.eventId,
          }),
        },
      }),
    ]);
    await recordSignature(id, userId, event);
    return NextResponse.json({ ok: true, status: "submitted" });
  });
}
