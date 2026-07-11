/**
 * E-sign shared types (docs/ESIGN_DESIGN.md). Dependency-free and
 * client-safe: these shapes travel between browser, API routes, the
 * server-side mirror pipeline, and the offline verifier.
 */

/** A raw ledger event document exactly as stored (Firestore or mock store). */
export interface RawLedgerEventDoc {
  eventId: string;
  /** Server-assigned creation time, epoch ms (rules-pinned in Firestore). */
  createdAtMs: number;
  encryptedData: string; // base64 AES-GCM ciphertext of the envelope JSON
  iv: string; // base64 12-byte IV
}

/** Decrypted-and-signature-checked event, ready for the reducers. */
export interface VerifiedEvent<A = EsignAction> {
  eventId: string;
  createdAtMs: number;
  signerPublicKey: string; // base64 SPKI, as embedded in the envelope
  action: A;
  /** SHA-256 hex over canonicalStringify(action) — the cross-reference key. */
  actionHash: string;
}

/** An event that failed decryption/signature/shape checks — kept, not hidden. */
export interface RejectedEvent {
  eventId: string;
  createdAtMs: number;
  reason: string;
}

// --- Roster actions ----------------------------------------------------------

export interface GenesisAction {
  t: "GENESIS";
  v: 1;
  ledger: string;
  ts: number;
  root: { uid: string; email: string; name: string; publicKey: string };
}

export interface AttestAction {
  t: "ATTEST";
  v: 1;
  ledger: string;
  ts: number;
  subject: { uid: string; email: string; name: string; publicKey: string };
}

export type EsignRole = "approver" | "treasurer" | "admin";

export interface GrantRoleAction {
  t: "GRANT_ROLE";
  v: 1;
  ledger: string;
  ts: number;
  uid: string;
  role: EsignRole;
}

export interface RevokeRoleAction {
  t: "REVOKE_ROLE";
  v: 1;
  ledger: string;
  ts: number;
  uid: string;
  role: EsignRole;
}

export interface RevokeKeyAction {
  t: "REVOKE_KEY";
  v: 1;
  ledger: string;
  ts: number;
  publicKey: string;
}

export type RosterAction =
  | GenesisAction
  | AttestAction
  | GrantRoleAction
  | RevokeRoleAction
  | RevokeKeyAction;

// --- Claim actions -----------------------------------------------------------

export interface SubmitAction {
  t: "SUBMIT";
  v: 1;
  ledger: string;
  ts: number;
  seq: number;
  /** Action hashes of the terminal events that closed thread seq−1; null for seq 1. */
  closesRef: string[] | null;
  claimId: string;
  packetSha256: string;
  rowsDigest: string;
  totalCents: number;
  requestorUid: string;
  approverUid: string;
  typedName: string;
  consentVersion: string;
  consentSha256: string;
  /** SHA-256 of the signer's hand-drawn signature data URL, when one exists. */
  signatureImageSha256?: string;
}

export interface ApproveAction {
  t: "APPROVE";
  v: 1;
  ledger: string;
  ts: number;
  claimId: string;
  packetSha256: string;
  submitRef: string;
  approverUid: string;
  typedName: string;
  consentVersion: string;
  consentSha256: string;
  comment: string;
  signatureImageSha256?: string;
}

export interface RejectAction {
  t: "REJECT";
  v: 1;
  ledger: string;
  ts: number;
  claimId: string;
  packetSha256: string;
  submitRef: string;
  approverUid: string;
  comment: string;
}

export interface WithdrawAction {
  t: "WITHDRAW";
  v: 1;
  ledger: string;
  ts: number;
  claimId: string;
  submitRef: string;
}

export interface MarkPaidAction {
  t: "MARK_PAID";
  v: 1;
  ledger: string;
  ts: number;
  claimId: string;
  packetSha256: string;
  approveRef: string;
  treasurerUid: string;
  typedName: string;
  consentVersion: string;
  consentSha256: string;
  checkNumber: string;
  signatureImageSha256?: string;
}

export type ClaimAction =
  | SubmitAction
  | ApproveAction
  | RejectAction
  | WithdrawAction
  | MarkPaidAction;

export type EsignAction = RosterAction | ClaimAction;

/** Roles ranked for "approver-or-above" checks. */
export const ROLE_RANK: Record<string, number> = {
  member: 0,
  approver: 1,
  treasurer: 2,
  admin: 3,
};

/** Claim statuses in which the packet (and line items) are frozen. */
export const FROZEN_STATUSES = [
  "generated",
  "submitted",
  "rejected",
  "approved",
  "paid",
] as const;

/** Statuses under active signature — packet regeneration is refused. */
export const SIGNED_STATUSES = ["submitted", "rejected", "approved", "paid"] as const;
