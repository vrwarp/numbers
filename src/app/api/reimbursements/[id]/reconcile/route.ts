import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { claimAccessRole } from "@/lib/esign/claim-server";
import { claimEvaluation, recordSignature, requireRegistry } from "@/lib/esign/server";
import type { RawLedgerEventDoc } from "@/lib/esign/types";

export const runtime = "nodejs";

/**
 * Mirror reconciliation (docs/ESIGN_DESIGN.md §5.5): any participant's
 * verifying view pushes raw ledger events the mirror lacks. The server
 * verifies each envelope and re-evaluates; it repairs MIRROR FACTS (lost
 * decision/paid/withdraw reports, missing SignatureRecords) but NEVER routes
 * new work — a self-appended SUBMIT surfaces as a discrepancy, not an inbox
 * entry.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const registry = await requireRegistry();
    const claim = await prisma.reimbursement.findUnique({ where: { id } });
    if (!claim) throw new ApiError(404, "Claim not found");
    await claimAccessRole(claim, userId);
    if (!claim.signatureLedgerId || !claim.signatureLedgerKey) {
      throw new ApiError(409, "Claim has no signature ledger on record");
    }

    const body = (await req.json().catch(() => ({}))) as { events?: RawLedgerEventDoc[] };
    const ledgerCtx = {
      ledgerId: claim.signatureLedgerId,
      ledgerKey: claim.signatureLedgerKey,
      ownerUid: claim.userId,
      claimId: id,
    };

    // Mirror any offered docs (create-once), then re-evaluate everything.
    if (Array.isArray(body.events) && body.events.length > 0) {
      for (const doc of body.events.slice(0, 200)) {
        await prisma.ledgerEventMirror
          .create({
            data: {
              ledgerId: claim.signatureLedgerId,
              eventId: String(doc.eventId).slice(0, 80),
              createdAtMs: BigInt(Math.floor(Number(doc.createdAtMs) || 0)),
              encryptedData: String(doc.encryptedData).slice(0, 200_000),
              iv: String(doc.iv).slice(0, 100),
            },
          })
          .catch(() => {});
      }
    }
    const { evaluation, events } = await claimEvaluation(registry, ledgerCtx);

    // Backfill SignatureRecords for verified events the mirror lacks.
    const identities = await prisma.signerIdentity.findMany({ where: { status: "attested" } });
    const uidByKey = new Map(identities.map((i) => [i.publicKey, i.userId]));
    for (const event of events) {
      const signer = uidByKey.get(event.signerPublicKey);
      if (signer) await recordSignature(id, signer, event);
    }

    // Repair lost transitions for the CURRENT thread only (§5.5): decisions,
    // payment, withdrawal. New SUBMITs never route work from here.
    const thread = evaluation.threads.find((t) => t.seq === claim.submitSeq);
    const discrepancies: string[] = [];
    let repaired: string | null = null;
    if (thread && claim.packetSha256 && thread.submit?.action.packetSha256 === claim.packetSha256) {
      if (claim.status === "submitted" && thread.state === "approved") repaired = "approved";
      else if (claim.status === "submitted" && thread.state === "rejected") repaired = "rejected";
      else if (claim.status === "submitted" && thread.state === "withdrawn") repaired = "generated";
      else if (claim.status === "approved" && thread.state === "paid") repaired = "paid";
    }
    if (repaired) {
      await prisma.$transaction([
        prisma.reimbursement.update({
          where: { id },
          data:
            repaired === "generated"
              ? { status: "generated", approverUserId: null }
              : repaired === "paid"
                ? { status: "paid", paidAt: new Date() }
                : { status: repaired, decidedAt: new Date() },
        }),
        prisma.auditEvent.create({
          data: {
            userId,
            reimbursementId: id,
            action: "esign-reconcile",
            detail: JSON.stringify({ from: claim.status, to: repaired }),
          },
        }),
      ]);
    }
    for (const t of evaluation.threads) {
      if (t.seq > claim.submitSeq) {
        discrepancies.push(
          `Ledger has a submission (seq ${t.seq}) the server never processed — it routes no work`
        );
      }
    }
    for (const a of evaluation.anomalies) {
      discrepancies.push(`${(a.event.action as { t?: string }).t ?? "?"}: ${a.reason}`);
    }
    return NextResponse.json({
      ok: true,
      status: repaired ?? claim.status,
      threads: evaluation.threads.map((t) => ({ seq: t.seq, state: t.state })),
      discrepancies,
    });
  });
}
