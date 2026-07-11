/**
 * Roster reducer (docs/ESIGN_DESIGN.md §4.4): replays the church roster
 * ledger into a timeline of who-is-attested-with-which-roles, queryable at
 * any instant (`stateAt`). Pure and isomorphic — the same code runs in the
 * browser, the server mirror pipeline, and the offline verifier. The roster
 * is always evaluated in full; truncation is invalidity, not degradation.
 */

import type {
  AttestAction,
  EsignRole,
  GenesisAction,
  RosterAction,
  VerifiedEvent,
} from "./types";

export interface RosterMember {
  uid: string;
  email: string;
  name: string;
  publicKey: string;
  /** When this key became attested (server time of the tipping event). */
  attestedAtMs: number;
  /** When this key was revoked, if ever. */
  revokedAtMs?: number;
}

interface RoleGrant {
  role: EsignRole;
  grantedAtMs: number;
  revokedAtMs?: number;
}

export interface RosterTimeline {
  rosterLedgerId: string;
  root: { uid: string; name: string; email: string; publicKey: string };
  /** Every key that ever became attested (including later-revoked ones). */
  members: RosterMember[];
  /** Attestations pending more vouches, keyed by subject public key. */
  pending: Map<string, { subject: AttestAction["subject"]; voucherUids: Set<string> }>;
  /** Events that were valid envelopes but failed roster rules — surfaced, not hidden. */
  anomalies: { event: VerifiedEvent<RosterAction>; reason: string }[];
  /** Member record for a key if attested (and not yet revoked) at time t. */
  memberAt(publicKey: string, tMs: number): RosterMember | undefined;
  /** Roles held by a uid at time t (root always has admin). */
  rolesAt(uid: string, tMs: number): EsignRole[];
  /** True when the uid holds approver-or-above at time t. */
  isApproverAt(uid: string, tMs: number): boolean;
}

const APPROVER_PLUS: EsignRole[] = ["approver", "treasurer", "admin"];

/**
 * Replay verified roster events (already envelope-checked, deduped, and
 * ordered by (createdAtMs, eventId) — see openLedger). Throws only on a
 * missing/invalid genesis, the unrecoverable case; everything else is an
 * anomaly entry.
 */
export function replayRoster(
  rosterLedgerId: string,
  events: VerifiedEvent<RosterAction>[]
): RosterTimeline {
  const anomalies: RosterTimeline["anomalies"] = [];
  const members: RosterMember[] = [];
  const pending = new Map<
    string,
    { subject: AttestAction["subject"]; voucherUids: Set<string> }
  >();
  const roles = new Map<string, RoleGrant[]>(); // uid → grants

  if (events.length === 0) throw new Error("Roster ledger is empty");
  const genesis = events[0];
  const g = genesis.action as GenesisAction;
  if (
    g.t !== "GENESIS" ||
    g.ledger !== rosterLedgerId ||
    !g.root?.publicKey ||
    genesis.signerPublicKey !== g.root.publicKey
  ) {
    throw new Error("Roster genesis is missing or not self-signed by the root key");
  }
  const root = { uid: g.root.uid, name: g.root.name, email: g.root.email, publicKey: g.root.publicKey };
  members.push({ ...g.root, attestedAtMs: genesis.createdAtMs });

  const memberAt = (publicKey: string, tMs: number): RosterMember | undefined => {
    return members.find(
      (m) =>
        m.publicKey === publicKey &&
        m.attestedAtMs <= tMs &&
        (m.revokedAtMs === undefined || m.revokedAtMs > tMs)
    );
  };
  const rolesAt = (uid: string, tMs: number): EsignRole[] => {
    if (uid === root.uid) return ["admin"];
    const out = new Set<EsignRole>();
    for (const grant of roles.get(uid) ?? []) {
      if (grant.grantedAtMs <= tMs && (grant.revokedAtMs === undefined || grant.revokedAtMs > tMs)) {
        out.add(grant.role);
      }
    }
    return [...out];
  };
  const isApproverAt = (uid: string, tMs: number) =>
    rolesAt(uid, tMs).some((r) => APPROVER_PLUS.includes(r));

  for (const event of events.slice(1)) {
    const a = event.action;
    const t = event.createdAtMs;
    const bad = (reason: string) => anomalies.push({ event, reason });

    if ((a as { ledger?: string }).ledger !== rosterLedgerId) {
      bad("wrong ledger id (cross-ledger replay)");
      continue;
    }

    if (a.t === "ATTEST") {
      const signer = memberAt(event.signerPublicKey, t);
      if (!signer) {
        bad("voucher is not an attested member");
        continue;
      }
      if (signer.uid === a.subject.uid) {
        bad("self-vouching never counts");
        continue;
      }
      if (members.some((m) => m.publicKey === a.subject.publicKey && m.revokedAtMs === undefined)) {
        continue; // already attested — extra vouches are harmless
      }
      const entry = pending.get(a.subject.publicKey) ?? {
        subject: a.subject,
        voucherUids: new Set<string>(),
      };
      entry.voucherUids.add(signer.uid);
      pending.set(a.subject.publicKey, entry);
      // Threshold (§4.3): two distinct attested vouchers, or one approver+.
      const tipped = entry.voucherUids.size >= 2 || isApproverAt(signer.uid, t);
      if (tipped) {
        members.push({ ...entry.subject, attestedAtMs: t });
        pending.delete(a.subject.publicKey);
      }
      continue;
    }

    // Everything below is root-only (v1).
    if (event.signerPublicKey !== root.publicKey) {
      bad(`${a.t} not signed by the root key`);
      continue;
    }
    if (a.t === "GRANT_ROLE") {
      const grants = roles.get(a.uid) ?? [];
      grants.push({ role: a.role, grantedAtMs: t });
      roles.set(a.uid, grants);
    } else if (a.t === "REVOKE_ROLE") {
      for (const grant of roles.get(a.uid) ?? []) {
        if (grant.role === a.role && grant.revokedAtMs === undefined) grant.revokedAtMs = t;
      }
    } else if (a.t === "REVOKE_KEY") {
      let hit = false;
      for (const m of members) {
        if (m.publicKey === a.publicKey && m.revokedAtMs === undefined) {
          m.revokedAtMs = t;
          hit = true;
        }
      }
      pending.delete(a.publicKey);
      if (!hit) bad("REVOKE_KEY for an unknown key");
    } else if (a.t === "GENESIS") {
      bad("second genesis event");
    } else {
      bad(`unknown roster action ${(a as { t?: string }).t}`);
    }
  }

  return { rosterLedgerId, root, members, pending, anomalies, memberAt, rolesAt, isApproverAt };
}
