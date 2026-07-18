/**
 * E-sign shared types (docs/ESIGN_DESIGN.md). Dependency-free and
 * client-safe: these shapes travel between browser, API routes, the
 * server-side mirror pipeline, and the offline verifier.
 */

import type { SignaturePlacement } from "./placement";

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

export type EsignRole = "approver" | "secretary" | "chairman" | "treasurer" | "admin";

/**
 * Roles whose holders may sign GRANT_ROLE/REVOKE_ROLE roster events (besides
 * the root key, which always can): the church's executive officers — chairman,
 * secretary, treasurer — plus admin. Granting/revoking the `admin` role itself
 * stays root-only. Enforced in the roster reducer (roster.ts) and mirrored in
 * scripts/verify-bundle.mjs.
 */
export const ROLE_MANAGER_ROLES: EsignRole[] = ["secretary", "chairman", "treasurer", "admin"];

/**
 * Approver-or-above (A11): every role that carries an approver's full
 * authority — approving claims, tipping attestation with a single vouch, the
 * §6.3 read grant. The executive officers are all approver-plus; finance
 * (MARK_PAID, the queue) stays treasurer/admin. One list feeds the ledger rule
 * (roster.ts isApproverAt, mirrored in scripts/verify-bundle.mjs) AND the app
 * surfaces (routes, pickers, nav) so they can never drift apart.
 */
export const APPROVER_PLUS_ROLES: EsignRole[] = [
  "approver",
  "secretary",
  "chairman",
  "treasurer",
  "admin",
];

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
  /** Where the signer click-placed their signature on the form (signed, so
   *  the position is part of the record). */
  signaturePlacement?: SignaturePlacement;
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
  signaturePlacement?: SignaturePlacement;
  /** SHA-256 (hex) of the APPROVED COPY: the submitted packet with the
   *  approver's ink/name/date stamped on (derived server-side at preflight
   *  from this payload's own signed fields, archived write-once). Signing
   *  this action binds BOTH versions — packetSha256 is the untouched
   *  original, this is the countersigned delivery copy — and MARK_PAID's
   *  approveRef pins it transitively. Absent on pre-feature approvals. */
  approvedPacketSha256?: string;
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

/** Roles ranked by breadth of capability — picks the single mirrored
 *  `User.role` when a uid holds several grants. A true chain: secretary/
 *  chairman = approver + role management; treasurer adds finance; admin adds
 *  the admin area (treasurer outranks chairman by capability, not board
 *  seniority). */
export const ROLE_RANK: Record<string, number> = {
  member: 0,
  approver: 1,
  secretary: 2,
  chairman: 3,
  treasurer: 4,
  admin: 5,
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
