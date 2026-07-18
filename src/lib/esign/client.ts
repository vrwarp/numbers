"use client";

/**
 * Browser-side e-sign flows (docs/ESIGN_DESIGN.md §4–§5): environment
 * loading, root-anchor checks, chain verification, and the ceremonies
 * (enroll, vouch, submit, decide, pay, withdraw). Every ceremony is
 * fail-closed: it independently hashes the bytes/refs it is about to sign
 * and refuses on any mismatch with the server's preflight payload.
 */

import type { FirebaseWebConfig } from "@/components/SignInCard";
// Static (not dynamic) import: firebase-client's module top-level is type-only,
// so this pulls in no Firebase SDK — but it lets connectSigningSession() reach
// signInWithPopup with no `await import` between the click and window.open,
// which iOS/Safari requires (see firebase-client `warm`).
import {
  ensureFirebaseAuth,
  hasMatchingFirebaseSession,
  preloadFirebase,
} from "./firebase-client";
import { actionHash, fingerprintMatches, keyFingerprint, sha256Hex } from "./canonical";
import { CONSENT_TEXT } from "./consent";
import { generateLedgerKey, openLedger, sealEnvelope, type SigningKeyPair } from "./envelope";
import { getCustody, rememberRoster, type KeyCustody } from "./custody";
import { placementsEqual, roundPlacement, type SignaturePlacement } from "./placement";
import { getLedgerStore, type EsignBackend, type LedgerStore } from "./store";
import { replayRoster, type RosterTimeline } from "./roster";
import { evaluateClaimLedger, type ClaimEvaluation } from "./validity";
import type {
  AttestAction,
  ClaimAction,
  GenesisAction,
  RawLedgerEventDoc,
  RosterAction,
  SubmitAction,
  VerifiedEvent,
  WithdrawAction,
} from "./types";

export interface EsignMe {
  userId: string;
  email: string;
  name: string;
  role: string;
  /** Duty pause (A10): a paused admin's role-management controls hide. */
  adminPaused: boolean;
  identityStatus: string | null;
  publicKey: string | null;
  signatureImage: string | null;
}

export interface EsignEnv {
  bootstrapped: boolean;
  /** Admin master switch (A5) — OFF by default; UI treats disabled like absent. */
  enabled?: boolean;
  /** Rollout scope (A8): "allowlist" (default) or "everyone". */
  scope?: "allowlist" | "everyone";
  /** Whether the signed-in user clears the rollout scope (admins always do). */
  allowed?: boolean;
  canToggle?: boolean;
  backend: EsignBackend;
  canBootstrap?: boolean;
  consentVersion?: string;
  rootPublicKey?: string;
  rootFingerprint?: string;
  configuredRootFingerprint?: string | null;
  rosterLedgerId?: string;
  rosterLedgerKey?: string | null;
  firebaseConfig?: FirebaseWebConfig | null;
  me: EsignMe;
}

async function jsonOrThrow(res: Response) {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Carry the server body so the UI can translate by `code`
    // (useThrownErrorMessage in src/lib/use-api-error.ts).
    const err = new Error(data?.error ?? `Request failed (${res.status})`) as Error & {
      payload?: unknown;
    };
    err.payload = data;
    throw err;
  }
  return data;
}

export async function loadEnv(): Promise<EsignEnv> {
  const env = (await jsonOrThrow(await fetch("/api/esign/registry"))) as EsignEnv;
  // Configure Firebase whenever the real backend is in play — including
  // BEFORE bootstrap, whose genesis ceremony already writes the ledger.
  if (env.backend === "firestore" && env.firebaseConfig) {
    const { configureFirebase } = await import("./firebase-client");
    configureFirebase(env.firebaseConfig, env.me.email);
  }
  return env;
}

// --- Signing session (the interactive Google popup) ------------------------------
//
// Only the production Firestore backend needs the Google sign-in popup; the
// mock backend has no Firebase and the emulator signs in silently. Because
// iOS/Safari blocks a popup opened after any async gap, e-sign surfaces
// establish the session up front from an explicit "Connect signing" click
// (SigningConnect.tsx) instead of letting it surface mid-ceremony.

/** True only when signing here would require the real Google popup. */
export function backendNeedsPopup(env: EsignEnv): boolean {
  return env.backend === "firestore" && !env.firebaseConfig?.emulator;
}

/** Does this device already have a usable signing session, so no interactive
 *  connect is needed? Always true for mock/emulator; otherwise a popup-free
 *  check of the restored Firebase session. */
export async function hasSigningSession(env: EsignEnv): Promise<boolean> {
  if (!backendNeedsPopup(env)) return true;
  return hasMatchingFirebaseSession();
}

/** Warm the Firebase SDK so the connect click can open the popup in-gesture.
 *  Never opens a popup; safe to call on mount. No-op when none is needed. */
export async function preloadSigningSession(env: EsignEnv): Promise<void> {
  if (!backendNeedsPopup(env)) return;
  await preloadFirebase();
}

/** Establish the signing session. For production Firestore this opens the
 *  Google popup and MUST be called straight from a user gesture (preload
 *  first). On the emulator it signs in silently; on mock it is a no-op. */
export async function connectSigningSession(env: EsignEnv): Promise<void> {
  if (env.backend !== "firestore") return;
  await ensureFirebaseAuth();
}

export function storeFor(env: EsignEnv): LedgerStore {
  return getLedgerStore(env.backend);
}

export function custodyFor(env: EsignEnv): KeyCustody {
  return getCustody(env.backend, env.me, env.rosterLedgerId);
}

function newLedgerId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Ceremony event ids derive from the action hash (§5.5): a double append is
 *  a create-on-existing no-op instead of a duplicate. */
function eventIdFor(hash: string): string {
  return `e${hash.slice(0, 40)}`;
}

// --- Root anchor (§4.6) --------------------------------------------------------

export type AnchorStatus =
  | { ok: true; pinnedBy: "deployment" | "tofu" | "first-use"; fingerprint: string }
  | { ok: false; reason: string };

export async function checkRootAnchor(env: EsignEnv, custody: KeyCustody): Promise<AnchorStatus> {
  if (!env.rootPublicKey) return { ok: false, reason: "No root key in the registry" };
  const fingerprint = await keyFingerprint(env.rootPublicKey);
  if (env.rootFingerprint && env.rootFingerprint !== fingerprint) {
    return { ok: false, reason: "Server-relayed fingerprint does not match the root key" };
  }
  if (env.configuredRootFingerprint) {
    return fingerprintMatches(fingerprint, env.configuredRootFingerprint)
      ? { ok: true, pinnedBy: "deployment", fingerprint }
      : { ok: false, reason: "Root key does not match this deployment's configured fingerprint" };
  }
  const pinned = await custody.getRootPin();
  if (pinned) {
    return fingerprintMatches(fingerprint, pinned) || pinned === fingerprint
      ? { ok: true, pinnedBy: "tofu", fingerprint }
      : { ok: false, reason: "Root key changed since this device pinned it — STOP and verify in person" };
  }
  await custody.setRootPin(fingerprint);
  return { ok: true, pinnedBy: "first-use", fingerprint };
}

// --- Roster & chain verification -------------------------------------------------

export interface RosterLoad {
  roster: RosterTimeline;
  rawDocs: RawLedgerEventDoc[];
  rejectedCount: number;
}

export async function loadRoster(env: EsignEnv): Promise<RosterLoad> {
  if (!env.rosterLedgerId || !env.rosterLedgerKey) {
    throw new Error("Roster key is not available — enroll first");
  }
  const store = storeFor(env);
  const rawDocs = await store.list(env.rosterLedgerId);
  const { events, rejected } = await openLedger(env.rosterLedgerKey, rawDocs);
  const roster = replayRoster(env.rosterLedgerId, events as VerifiedEvent<RosterAction>[]);
  if (roster.root.publicKey !== env.rootPublicKey) {
    throw new Error("Roster genesis does not match the registry root key");
  }
  return { roster, rawDocs, rejectedCount: rejected.length };
}

/** Live-watch the roster ledger so a vouch (pending → attested), role grant, or
 *  key revocation made on another device surfaces here without a manual reload
 *  (§4.3). `onChange` fires only on changes after subscription — the caller
 *  re-reads and re-reports the roster to refresh the mirror. Returns the
 *  unsubscribe; a no-op when no roster is enrolled yet. */
export function subscribeRoster(env: EsignEnv, onChange: () => void): () => void {
  if (!env.rosterLedgerId) return () => {};
  return storeFor(env).subscribe(env.rosterLedgerId, onChange);
}

/** Push the full roster to the server's verified-mirror pipeline (§5.5). */
export async function reportRoster(env: EsignEnv, rawDocs: RawLedgerEventDoc[]): Promise<void> {
  await jsonOrThrow(
    await fetch("/api/esign/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: rawDocs }),
    })
  );
}

export interface ClaimChain {
  anchor: AnchorStatus;
  roster: RosterTimeline;
  evaluation: ClaimEvaluation;
  claimDocs: RawLedgerEventDoc[];
  /** Hash of the archived packet bytes fetched from the server, or null. */
  packetSha256: string | null;
  packetBytes: ArrayBuffer | null;
}

export async function verifyClaimChain(
  env: EsignEnv,
  claim: {
    id: string;
    ownerUid: string;
    signatureLedgerId: string;
    signatureLedgerKey: string;
    packetSha256?: string | null;
  }
): Promise<ClaimChain> {
  const custody = custodyFor(env);
  const anchor = await checkRootAnchor(env, custody);
  const { roster } = await loadRoster(env);
  const store = storeFor(env);
  const claimDocs = await store.list(claim.signatureLedgerId);
  const { events } = await openLedger(claim.signatureLedgerKey, claimDocs);
  const evaluation = evaluateClaimLedger({
    claimId: claim.id,
    ledgerId: claim.signatureLedgerId,
    ownerUid: claim.ownerUid,
    roster,
    events: events as VerifiedEvent<ClaimAction>[],
  });
  let packetSha256: string | null = null;
  let packetBytes: ArrayBuffer | null = null;
  const res = await fetch(
    `/api/reimbursements/${claim.id}/packet${claim.packetSha256 ? `?sha=${claim.packetSha256}` : ""}`
  );
  if (res.ok) {
    packetBytes = await res.arrayBuffer();
    packetSha256 = await sha256Hex(new Uint8Array(packetBytes));
  }
  return { anchor, roster, evaluation, claimDocs, packetSha256, packetBytes };
}

/** Reconcile the mirror from a verifying view (§5.5). */
export async function reconcileClaim(claimId: string, docs: RawLedgerEventDoc[]): Promise<unknown> {
  return jsonOrThrow(
    await fetch(`/api/reimbursements/${claimId}/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: docs }),
    })
  );
}

// --- Enrollment & vouching (§4.2–4.3) ---------------------------------------------

export async function enroll(
  env: EsignEnv,
  signatureImage: string
): Promise<{ publicKey: string; status: string }> {
  // Row first (unlocks key relay + records consent), then key, then report it.
  const first = await jsonOrThrow(
    await fetch("/api/esign/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signatureImage }),
    })
  );
  const custody = custodyFor(env);
  const identity = await custody.ensureIdentity(first.rosterLedgerId, first.rosterLedgerKey);
  await custody.saveLedgerKey(first.rosterLedgerId, first.rosterLedgerKey);
  await rememberRoster(first.rosterLedgerId);
  const second = await jsonOrThrow(
    await fetch("/api/esign/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: identity.publicKeyB64, signatureImage }),
    })
  );
  return { publicKey: identity.publicKeyB64, status: second.identityStatus };
}

/** Finish a half-completed enrollment (§4.2). enroll() is a multi-step,
 *  non-atomic flow — the identity row lands first, the roster key is
 *  reported last — so a death in between (the production case: Safari
 *  killing the tab's Firestore channel mid-custody, then a refresh) leaves
 *  status "pending" with NO publicKey: no vouch QR, invisible in
 *  /api/esign/pending, and no UI path out. A device whose custody is ready
 *  can always re-derive the key (ensureIdentity returns the existing
 *  keypair, or mints one where enroll() itself would have — the route
 *  treats a changed key as a fresh enrollment restart), so the identity
 *  card calls this opportunistically. Returns true when a key was
 *  (re)reported and the env should be reloaded. */
export async function repairEnrollment(env: EsignEnv): Promise<boolean> {
  if (!env.me.identityStatus || env.me.publicKey) return false;
  if (!env.rosterLedgerId || !env.rosterLedgerKey) return false;
  const identity = await custodyFor(env).ensureIdentity(env.rosterLedgerId, env.rosterLedgerKey);
  await rememberRoster(env.rosterLedgerId);
  await jsonOrThrow(
    await fetch("/api/esign/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: identity.publicKeyB64 }),
    })
  );
  return true;
}

/** Update the hand-drawn signature alone (never touches attestation). */
export async function updateSignatureImage(signatureImage: string): Promise<void> {
  await jsonOrThrow(
    await fetch("/api/esign/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signatureImage }),
    })
  );
}

async function appendToLedger(
  env: EsignEnv,
  ledgerId: string,
  ledgerKey: string,
  identity: SigningKeyPair,
  action: RosterAction | ClaimAction
): Promise<RawLedgerEventDoc> {
  const sealed = await sealEnvelope(ledgerKey, identity.privateKeyB64, identity.publicKeyB64, action);
  const hash = await actionHash(action);
  const eventId = eventIdFor(hash);
  const store = storeFor(env);
  await store.append(ledgerId, { eventId, ...sealed });
  const doc = (await store.list(ledgerId)).find((d) => d.eventId === eventId);
  if (!doc) throw new Error("Appended event did not come back from the store");
  return doc;
}

export async function bootstrapRegistry(env: EsignEnv): Promise<void> {
  const custody = custodyFor(env);
  const rosterLedgerId = newLedgerId();
  const rosterLedgerKey = await generateLedgerKey();
  const identity = await custody.ensureIdentity(rosterLedgerId, rosterLedgerKey);
  const genesis: GenesisAction = {
    t: "GENESIS",
    v: 1,
    ledger: rosterLedgerId,
    ts: Date.now(),
    root: {
      uid: env.me.userId,
      email: env.me.email,
      name: env.me.name,
      publicKey: identity.publicKeyB64,
    },
  };
  const genesisDoc = await appendToLedger(env, rosterLedgerId, rosterLedgerKey, identity, genesis);
  await jsonOrThrow(
    await fetch("/api/esign/registry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rosterLedgerId,
        rosterLedgerKey,
        rootPublicKey: identity.publicKeyB64,
        genesisDoc,
      }),
    })
  );
  await custody.saveLedgerKey(rosterLedgerId, rosterLedgerKey);
  await rememberRoster(rosterLedgerId);
  await custody.setRootPin(await keyFingerprint(identity.publicKeyB64));
}

export interface VouchSubject {
  uid: string;
  email: string;
  name: string;
  publicKey: string;
}

export async function vouchFor(env: EsignEnv, subject: VouchSubject): Promise<void> {
  if (!env.rosterLedgerId || !env.rosterLedgerKey) throw new Error("Enroll before vouching");
  const custody = custodyFor(env);
  const identity = await custody.getIdentity(env.rosterLedgerId);
  if (!identity) throw new Error("No signing identity on this device");
  const attest: AttestAction = {
    t: "ATTEST",
    v: 1,
    ledger: env.rosterLedgerId,
    ts: Date.now(),
    subject,
  };
  await appendToLedger(env, env.rosterLedgerId, env.rosterLedgerKey, identity, attest);
  const { rawDocs } = await loadRoster(env);
  await reportRoster(env, rawDocs);
}

/** Grant/revoke a role, then refresh the mirror. Valid only when this device's
 *  signer is the root or an executive officer/admin at signing time (the
 *  reducer's role-management rule); the admin role itself is never offered. */
export async function grantRole(
  env: EsignEnv,
  uid: string,
  role: "approver" | "secretary" | "chairman" | "treasurer",
  revoke = false
): Promise<void> {
  if (!env.rosterLedgerId || !env.rosterLedgerKey) throw new Error("Not enrolled");
  const custody = custodyFor(env);
  const identity = await custody.getIdentity(env.rosterLedgerId);
  if (!identity) throw new Error("No signing identity on this device");
  await appendToLedger(env, env.rosterLedgerId, env.rosterLedgerKey, identity, {
    t: revoke ? "REVOKE_ROLE" : "GRANT_ROLE",
    v: 1,
    ledger: env.rosterLedgerId,
    ts: Date.now(),
    uid,
    role,
  });
  const { rawDocs } = await loadRoster(env);
  await reportRoster(env, rawDocs);
}

/** Root-only: revoke a member's signing KEY (§4.5 compromised-device path).
 *  Forward-only — history signed by the key stays valid via stateAt (§4.4). */
export async function revokeMemberKey(env: EsignEnv, publicKey: string): Promise<void> {
  if (!env.rosterLedgerId || !env.rosterLedgerKey) throw new Error("Not enrolled");
  const custody = custodyFor(env);
  const identity = await custody.getIdentity(env.rosterLedgerId);
  if (!identity) throw new Error("No signing identity on this device");
  await appendToLedger(env, env.rosterLedgerId, env.rosterLedgerKey, identity, {
    t: "REVOKE_KEY",
    v: 1,
    ledger: env.rosterLedgerId,
    ts: Date.now(),
    publicKey,
  });
  const { rawDocs } = await loadRoster(env);
  await reportRoster(env, rawDocs);
}

// --- Claim ceremonies (§5.5: preflight → verify → append → report) ---------------

async function ceremonyIdentity(env: EsignEnv): Promise<SigningKeyPair> {
  if (!env.rosterLedgerId) throw new Error("Not enrolled");
  const identity = await custodyFor(env).getIdentity(env.rosterLedgerId);
  if (!identity) {
    throw new Error("Your signing key is not on this device — enroll or recover it first");
  }
  return identity;
}

/** The signer must be shown/sign the exact consent text hash it carries. */
async function assertConsentHash(payload: unknown): Promise<void> {
  const hash = (payload as { consentSha256?: unknown }).consentSha256;
  if (typeof hash === "string" && hash !== (await sha256Hex(CONSENT_TEXT))) {
    throw new Error("Consent text mismatch — refusing to sign");
  }
}

export async function runSubmitCeremony(
  claim: { id: string; signatureLedgerId?: string | null; signatureLedgerKey?: string | null },
  form: { approverUserId: string; typedName: string; placement?: SignaturePlacement }
): Promise<void> {
  const env = await loadEnv();
  const identity = await ceremonyIdentity(env);
  const custody = custodyFor(env);

  let ledgerId = claim.signatureLedgerId ?? null;
  let ledgerKey = claim.signatureLedgerKey ?? null;
  if (!ledgerId) {
    ledgerId = newLedgerId();
    ledgerKey = await generateLedgerKey();
  }
  const preflight = (await jsonOrThrow(
    await fetch(`/api/reimbursements/${claim.id}/submit?preflight=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, ledgerId }),
    })
  )) as { payload: SubmitAction; needLedgerKey: boolean };
  const payload = preflight.payload;

  // Fail-closed: refuse to sign a placement we didn't choose.
  if (form.placement && !placementsEqual(payload.signaturePlacement, roundPlacement(form.placement))) {
    throw new Error("Server placed the signature differently than you did — refusing to sign");
  }

  // Fail-closed (§5.3): hash the exact stored bytes ourselves; sign OUR hash
  // only if the server pinned the same one.
  const res = await fetch(`/api/reimbursements/${claim.id}/packet`);
  if (!res.ok) throw new Error("Could not fetch the packet to hash");
  const myHash = await sha256Hex(new Uint8Array(await res.arrayBuffer()));
  if (myHash !== payload.packetSha256) {
    throw new Error("The packet on the server changed under you — reload and retry");
  }
  await assertConsentHash(payload);
  if (payload.requestorUid !== env.me.userId || payload.approverUid !== form.approverUserId) {
    throw new Error("Preflight payload does not match this ceremony — refusing to sign");
  }

  if (!ledgerKey) {
    ledgerKey = (await custody.getLedgerKey(payload.ledger)) ?? null;
    if (!ledgerKey) throw new Error("Missing the claim ledger key on this device");
  }
  const doc = await appendToLedger(env, payload.ledger, ledgerKey, identity, payload);
  await custody.saveLedgerKey(payload.ledger, ledgerKey);
  await jsonOrThrow(
    await fetch(`/api/reimbursements/${claim.id}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...doc, ledgerKey: preflight.needLedgerKey ? ledgerKey : undefined }),
    })
  );
}

export async function runDecisionCeremony(
  claim: { id: string; signatureLedgerId: string; signatureLedgerKey: string },
  form: { decision: "approve" | "reject"; comment?: string; typedName?: string; placement?: SignaturePlacement },
  expected: { submitRef: string; packetSha256: string }
): Promise<void> {
  const env = await loadEnv();
  const identity = await ceremonyIdentity(env);
  const payload = (
    (await jsonOrThrow(
      await fetch(`/api/reimbursements/${claim.id}/decision?preflight=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
    )) as { payload: ClaimAction }
  ).payload as ClaimAction & {
    submitRef: string;
    packetSha256: string;
    signaturePlacement?: SignaturePlacement;
    approvedPacketSha256?: string;
  };
  // The decision must reference EXACTLY the SUBMIT this client verified.
  if (payload.submitRef !== expected.submitRef || payload.packetSha256 !== expected.packetSha256) {
    throw new Error("Server's decision target differs from what you verified — refusing to sign");
  }
  if (
    form.decision === "approve" &&
    form.placement &&
    !placementsEqual(payload.signaturePlacement, roundPlacement(form.placement))
  ) {
    throw new Error("Server placed the signature differently than you did — refusing to sign");
  }
  // Fail-closed on the approved copy (tier 3): signing an APPROVE binds its
  // hash too, so hash the exact archived bytes ourselves before signing.
  if (form.decision === "approve") {
    if (!payload.approvedPacketSha256) {
      throw new Error("Server did not derive the approved copy — refusing to sign");
    }
    const copy = await fetch(
      `/api/reimbursements/${claim.id}/packet?sha=${payload.approvedPacketSha256}`
    );
    if (!copy.ok) throw new Error("Could not fetch the approved copy to hash");
    const copyHash = await sha256Hex(new Uint8Array(await copy.arrayBuffer()));
    if (copyHash !== payload.approvedPacketSha256) {
      throw new Error("The approved copy's bytes do not match its pinned hash — refusing to sign");
    }
  }
  await assertConsentHash(payload);
  const doc = await appendToLedger(env, claim.signatureLedgerId, claim.signatureLedgerKey, identity, payload);
  await jsonOrThrow(
    await fetch(`/api/reimbursements/${claim.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    })
  );
}

export async function runPaidCeremony(
  claim: { id: string; signatureLedgerId: string; signatureLedgerKey: string },
  form: { checkNumber?: string; typedName: string },
  expected: { approveRef: string; packetSha256: string }
): Promise<void> {
  const env = await loadEnv();
  const identity = await ceremonyIdentity(env);
  const payload = (
    (await jsonOrThrow(
      await fetch(`/api/reimbursements/${claim.id}/paid?preflight=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
    )) as { payload: ClaimAction }
  ).payload as ClaimAction & { approveRef: string; packetSha256: string };
  if (payload.approveRef !== expected.approveRef || payload.packetSha256 !== expected.packetSha256) {
    throw new Error("Server's payment target differs from what you verified — refusing to sign");
  }
  await assertConsentHash(payload);
  const doc = await appendToLedger(env, claim.signatureLedgerId, claim.signatureLedgerKey, identity, payload);
  await jsonOrThrow(
    await fetch(`/api/reimbursements/${claim.id}/paid`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    })
  );
}

/** Close the open submission (reassignment / pre-revert honesty marker). */
export async function withdrawSubmission(
  claim: { id: string; signatureLedgerId: string; signatureLedgerKey: string },
  submitActionHash: string
): Promise<void> {
  const env = await loadEnv();
  const identity = await ceremonyIdentity(env);
  const action: WithdrawAction = {
    t: "WITHDRAW",
    v: 1,
    ledger: claim.signatureLedgerId,
    ts: Date.now(),
    claimId: claim.id,
    submitRef: submitActionHash,
  };
  const doc = await appendToLedger(env, claim.signatureLedgerId, claim.signatureLedgerKey, identity, action);
  await reconcileClaim(claim.id, [doc]);
}
