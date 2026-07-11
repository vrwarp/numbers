/**
 * Server-side claim ceremony machinery (docs/ESIGN_DESIGN.md §5.1, §5.5,
 * §6) — SERVER ONLY. Shared by the submit/decision/paid/reconcile/packet
 * routes: participant access, pending-action pins, the per-hash packet
 * archive, and rows digests.
 */

import fs from "fs/promises";
import path from "path";
import type { LineItem, Reimbursement } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api";
import { dataDir } from "@/lib/config";
import { canonicalStringify, sha256Hex } from "./canonical";
import { FROZEN_STATUSES, type ClaimAction } from "./types";

export const SHA256_HEX = /^[0-9a-f]{64}$/;

// --- Signed packet archive (§5.1) ---------------------------------------------

/** DATA_DIR-relative path of an archived signed packet version. The sha MUST
 *  be format-validated before this is called — the traversal guard alone
 *  would let a crafted value escape the claim's directory. */
export function signedPacketPath(userId: string, claimId: string, sha256: string): string {
  if (!SHA256_HEX.test(sha256)) throw new ApiError(400, "Bad packet hash");
  return path.join("signed", userId, claimId, `${sha256}.pdf`);
}

/** Archive the exact bytes that were hashed (write-once; never overwritten). */
export async function archiveSignedPacket(
  userId: string,
  claimId: string,
  sha256: string,
  bytes: Buffer
): Promise<void> {
  const abs = path.resolve(dataDir(), signedPacketPath(userId, claimId, sha256));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    await fs.writeFile(abs, bytes, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; // same hash ⇒ same bytes
  }
}

// --- Access (§6.3: the ONLY non-owner claim read grants) -----------------------

export type ClaimRole = "owner" | "approver" | "treasurer";

export async function claimAccessRole(
  claim: Pick<Reimbursement, "userId" | "approverUserId">,
  userId: string
): Promise<ClaimRole> {
  if (claim.userId === userId) return "owner";
  if (claim.approverUserId === userId) return "approver";
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role === "treasurer" || user?.role === "admin") return "treasurer";
  throw new ApiError(404, "Claim not found"); // cross-tenant: 404, never 403
}

// --- Pending ceremony actions (§5.5) --------------------------------------------

type PendingMap = Record<string, ClaimAction>;

export function getPendingAction(claim: Reimbursement, signerUserId: string): ClaimAction | null {
  try {
    return ((JSON.parse(claim.pendingActionsJson) as PendingMap)[signerUserId] as ClaimAction) ?? null;
  } catch {
    return null;
  }
}

export async function setPendingAction(
  claimId: string,
  pendingActionsJson: string,
  signerUserId: string,
  action: ClaimAction | null
): Promise<void> {
  let map: PendingMap = {};
  try {
    map = JSON.parse(pendingActionsJson) as PendingMap;
  } catch {
    map = {};
  }
  if (action === null) delete map[signerUserId];
  else map[signerUserId] = action;
  await prisma.reimbursement.update({
    where: { id: claimId },
    data: { pendingActionsJson: JSON.stringify(map) },
  });
}

// --- Claim content digests (§5.2) -----------------------------------------------

export async function rowsDigestAndTotal(
  lineItems: LineItem[]
): Promise<{ rowsDigest: string; totalCents: number }> {
  const active = lineItems
    .filter((it) => !it.isExcluded)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((it) => ({
      description: it.description,
      amountCents: it.amountCents,
      ministry: it.ministry,
      event: it.event,
    }));
  return {
    rowsDigest: await sha256Hex(canonicalStringify(active)),
    totalCents: active.reduce((s, it) => s + it.amountCents, 0),
  };
}

/** The signer's identity must be attested and match the reporting session. */
export async function requireAttestedIdentity(
  userId: string
): Promise<{ publicKey: string; signatureImage: string }> {
  const identity = await prisma.signerIdentity.findUnique({ where: { userId } });
  if (!identity || identity.status !== "attested" || !identity.publicKey) {
    throw new ApiError(409, "Your signing identity is not attested yet");
  }
  return { publicKey: identity.publicKey, signatureImage: identity.signatureImage };
}

// --- Claim summary serializer for approver/finance/verification views ------------

export function claimSummary(claim: Reimbursement & { lineItems: LineItem[] }, ownerName: string) {
  const active = claim.lineItems.filter((it) => !it.isExcluded);
  return {
    id: claim.id,
    status: claim.status,
    ownerName,
    ownerUid: claim.userId,
    approverUserId: claim.approverUserId,
    claimDescription: claim.claimDescription,
    totalCents: active.reduce((s, it) => s + it.amountCents, 0),
    packetSha256: claim.packetSha256,
    signatureLedgerId: claim.signatureLedgerId,
    submitSeq: claim.submitSeq,
    submittedAt: claim.submittedAt,
    decidedAt: claim.decidedAt,
    paidAt: claim.paidAt,
    checkNumber: claim.checkNumber,
    rows: active
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((it) => ({
        description: it.description,
        amountCents: it.amountCents,
        ministry: it.ministry,
        event: it.event,
      })),
  };
}
