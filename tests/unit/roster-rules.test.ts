import { describe, expect, it } from "vitest";
import { replayRoster } from "@/lib/esign/roster";
import type {
  AttestAction,
  GenesisAction,
  GrantRoleAction,
  RevokeKeyAction,
  RosterAction,
  VerifiedEvent,
} from "@/lib/esign/types";

/**
 * replayRoster consumes already-envelope-checked VerifiedEvents, so we can
 * build them as plain objects (no crypto) and exercise the pure attestation
 * rules directly. These pin the trust-model invariants: self-vouch never
 * counts, the root is fixed, the two-voucher / one-approver threshold, key
 * supersession, and — the freshly fixed rule — that pooled vouches must name
 * the SAME subject identity.
 */

const ROSTER = "roster-L1";
let seq = 0;

function ev<A extends RosterAction>(
  action: A,
  signerPublicKey: string,
  createdAtMs: number
): VerifiedEvent<A> {
  seq += 1;
  return {
    eventId: `e${seq}-${createdAtMs}`,
    createdAtMs,
    signerPublicKey,
    action,
    actionHash: `h${seq}`,
  };
}

function genesis(createdAtMs = 0): VerifiedEvent<GenesisAction> {
  return ev(
    { t: "GENESIS", v: 1, ledger: ROSTER, ts: createdAtMs, root: { uid: "root", email: "root@c.org", name: "Root", publicKey: "K_root" } },
    "K_root",
    createdAtMs
  );
}

function attest(
  signerKey: string,
  subject: AttestAction["subject"],
  createdAtMs: number
): VerifiedEvent<AttestAction> {
  return ev({ t: "ATTEST", v: 1, ledger: ROSTER, ts: createdAtMs, subject }, signerKey, createdAtMs);
}

function grant(
  uid: string,
  createdAtMs: number,
  role: GrantRoleAction["role"] = "approver",
  signerKey = "K_root"
): VerifiedEvent<GrantRoleAction> {
  return ev({ t: "GRANT_ROLE", v: 1, ledger: ROSTER, ts: createdAtMs, uid, role }, signerKey, createdAtMs);
}

const subj = (uid: string, key: string, over: Partial<AttestAction["subject"]> = {}): AttestAction["subject"] => ({
  uid,
  email: `${uid}@c.org`,
  name: uid.toUpperCase(),
  publicKey: key,
  ...over,
});

describe("replayRoster genesis", () => {
  it("throws on an empty ledger", () => {
    expect(() => replayRoster(ROSTER, [])).toThrow();
  });

  it("throws when genesis is not self-signed by the root key", () => {
    const bad = ev(
      { t: "GENESIS", v: 1, ledger: ROSTER, ts: 0, root: { uid: "root", email: "r@c.org", name: "R", publicKey: "K_root" } },
      "K_someone_else",
      0
    );
    expect(() => replayRoster(ROSTER, [bad])).toThrow();
  });

  it("seats the root as an attested admin member", () => {
    const t = replayRoster(ROSTER, [genesis()]);
    expect(t.memberAt("K_root", 10)?.uid).toBe("root");
    expect(t.rolesAt("root", 10)).toEqual(["admin"]);
    expect(t.isApproverAt("root", 10)).toBe(true);
  });
});

describe("attestation threshold", () => {
  it("needs two distinct vouchers when neither is an approver", () => {
    // Seat member A (vouched by root, an approver → tips immediately).
    const events = [
      genesis(),
      attest("K_root", subj("a", "K_a"), 10),
      // Now A (member, not approver) and root vouch B.
    ];
    const withOneNonApprover = [...events, attest("K_a", subj("b", "K_b"), 20)];
    let t = replayRoster(ROSTER, withOneNonApprover);
    expect(t.memberAt("K_b", 25)).toBeUndefined(); // one non-approver vouch is not enough

    const tipped = [...withOneNonApprover, attest("K_root", subj("b", "K_b"), 30)];
    t = replayRoster(ROSTER, tipped);
    expect(t.memberAt("K_b", 35)?.uid).toBe("b");
  });

  it("a single approver vouch tips attestation", () => {
    const t = replayRoster(ROSTER, [genesis(), attest("K_root", subj("a", "K_a"), 10)]);
    expect(t.memberAt("K_a", 15)?.uid).toBe("a");
    expect(t.memberAt("K_a", 5)).toBeUndefined(); // not before its attestation time
  });

  it("self-vouching never counts", () => {
    const t = replayRoster(ROSTER, [
      genesis(),
      attest("K_root", subj("a", "K_a"), 10),
      // A self-vouches for a new key of their own — inert.
      attest("K_a", subj("a", "K_a2"), 20),
    ]);
    expect(t.memberAt("K_a2", 25)).toBeUndefined();
    expect(t.anomalies.some((x) => /self-vouch/i.test(x.reason))).toBe(true);
  });

  it("refuses to re-vouch the root key", () => {
    const t = replayRoster(ROSTER, [
      genesis(),
      attest("K_root", subj("a", "K_a"), 10),
      attest("K_a", subj("root", "K_root2"), 20),
      grant("a", 15),
    ]);
    expect(t.anomalies.some((x) => /root/i.test(x.reason))).toBe(true);
  });
});

describe("pooled vouches must name the same subject identity (regression)", () => {
  it("does NOT combine two vouches that disagree on the subject uid for one key", () => {
    // Two members each vouch key K_x, but under DIFFERENT uids. Individually
    // neither reaches threshold (they're non-approver members), and because
    // they name different identities their vouches must not pool.
    const events = [
      genesis(),
      attest("K_root", subj("a", "K_a"), 10), // A seated (approver-vouched)
      attest("K_root", subj("b", "K_b"), 11), // B seated
      // A vouches K_x as uid "victim"; B vouches K_x as uid "attacker".
      attest("K_a", subj("victim", "K_x"), 20),
      attest("K_b", subj("attacker", "K_x"), 21),
    ];
    const t = replayRoster(ROSTER, events);
    // Neither identity may become attested from the mismatched pool.
    expect(t.memberAt("K_x", 30)).toBeUndefined();
    expect(t.anomalies.some((x) => /conflicting subject/i.test(x.reason))).toBe(true);
  });

  it("still combines two vouches that agree on the full identity", () => {
    const s = subj("c", "K_c");
    const t = replayRoster(ROSTER, [
      genesis(),
      attest("K_root", subj("a", "K_a"), 10),
      attest("K_root", subj("b", "K_b"), 11),
      attest("K_a", s, 20),
      attest("K_b", s, 21),
    ]);
    expect(t.memberAt("K_c", 30)?.uid).toBe("c");
  });
});

describe("executive-officer role management", () => {
  // Root seats A and B; A becomes an officer; grants signed by A follow.
  const seated = (officerRole: "chairman" | "secretary" | "treasurer") => [
    genesis(),
    attest("K_root", subj("a", "K_a"), 10),
    attest("K_root", subj("b", "K_b"), 11),
    grant("a", 20, officerRole),
  ];

  it.each(["chairman", "secretary", "treasurer"] as const)(
    "a %s can grant and revoke member roles",
    (officerRole) => {
      const granted = replayRoster(ROSTER, [...seated(officerRole), grant("b", 30, "approver", "K_a")]);
      expect(granted.rolesAt("b", 35)).toEqual(["approver"]);
      expect(granted.anomalies).toEqual([]);

      const revoke = ev(
        { t: "REVOKE_ROLE", v: 1, ledger: ROSTER, ts: 40, uid: "b", role: "approver" } as RosterAction,
        "K_a",
        40
      );
      const revoked = replayRoster(ROSTER, [...seated(officerRole), grant("b", 30, "approver", "K_a"), revoke]);
      expect(revoked.rolesAt("b", 45)).toEqual([]);
      expect(revoked.rolesAt("b", 35)).toEqual(["approver"]); // forward-only
    }
  );

  it("officers can appoint other officers (chairman grants secretary)", () => {
    const t = replayRoster(ROSTER, [...seated("chairman"), grant("b", 30, "secretary", "K_a")]);
    expect(t.rolesAt("b", 35)).toEqual(["secretary"]);
  });

  it("a plain member or approver cannot grant roles", () => {
    const asMember = replayRoster(ROSTER, [
      genesis(),
      attest("K_root", subj("a", "K_a"), 10),
      grant("b", 30, "approver", "K_a"),
    ]);
    expect(asMember.rolesAt("b", 35)).toEqual([]);
    expect(asMember.anomalies.some((x) => /role-management authority/.test(x.reason))).toBe(true);

    const asApprover = replayRoster(ROSTER, [
      genesis(),
      attest("K_root", subj("a", "K_a"), 10),
      grant("a", 20, "approver"),
      grant("b", 30, "treasurer", "K_a"),
    ]);
    expect(asApprover.rolesAt("b", 35)).toEqual([]);
    expect(asApprover.anomalies.some((x) => /role-management authority/.test(x.reason))).toBe(true);
  });

  it("the admin role itself stays root-only — officers can neither mint nor depose admins", () => {
    const mint = replayRoster(ROSTER, [...seated("chairman"), grant("b", 30, "admin", "K_a")]);
    expect(mint.rolesAt("b", 35)).toEqual([]);
    expect(mint.anomalies.some((x) => /admin role is root-only/.test(x.reason))).toBe(true);

    const depose = replayRoster(ROSTER, [
      ...seated("chairman"),
      grant("b", 25, "admin"), // root-signed: valid
      ev({ t: "REVOKE_ROLE", v: 1, ledger: ROSTER, ts: 30, uid: "b", role: "admin" } as RosterAction, "K_a", 30),
    ]);
    expect(depose.rolesAt("b", 35)).toEqual(["admin"]);
    expect(depose.anomalies.some((x) => /admin role is root-only/.test(x.reason))).toBe(true);
  });

  it("authority is checked at exercise time (A9): a revoked officer's later grants are void", () => {
    const t = replayRoster(ROSTER, [
      ...seated("secretary"),
      ev({ t: "REVOKE_ROLE", v: 1, ledger: ROSTER, ts: 25, uid: "a", role: "secretary" } as RosterAction, "K_root", 25),
      grant("b", 30, "approver", "K_a"),
    ]);
    expect(t.rolesAt("b", 35)).toEqual([]);
    expect(t.anomalies.some((x) => /role-management authority/.test(x.reason))).toBe(true);
    // …and grants signed BEFORE their own grant existed are void too.
    const early = replayRoster(ROSTER, [
      genesis(),
      attest("K_root", subj("a", "K_a"), 10),
      grant("b", 15, "approver", "K_a"), // A not yet an officer
      grant("a", 20, "secretary"),
    ]);
    expect(early.rolesAt("b", 35)).toEqual([]);
  });

  it("chairman and secretary hold no approver-or-above authority", () => {
    const t = replayRoster(ROSTER, [...seated("chairman"), grant("b", 30, "secretary", "K_a")]);
    expect(t.isApproverAt("a", 35)).toBe(false);
    expect(t.isApproverAt("b", 35)).toBe(false);
    // A single officer vouch therefore does NOT tip attestation by itself.
    const vouch = replayRoster(ROSTER, [...seated("chairman"), attest("K_a", subj("c", "K_c"), 30)]);
    expect(vouch.memberAt("K_c", 35)).toBeUndefined();
  });
});

describe("key supersession and revocation", () => {
  it("a newly attested key retires the uid's earlier key at that instant", () => {
    const t = replayRoster(ROSTER, [
      genesis(),
      attest("K_root", subj("a", "K_a1"), 10),
      attest("K_root", subj("a", "K_a2"), 50),
    ]);
    // Old key valid before 50, revoked at 50; new key valid from 50.
    expect(t.memberAt("K_a1", 40)?.uid).toBe("a");
    expect(t.memberAt("K_a1", 60)).toBeUndefined();
    expect(t.memberAt("K_a2", 60)?.uid).toBe("a");
    // Forward-only: things signed before 50 with K_a1 still verify.
    expect(t.memberAt("K_a1", 49)?.uid).toBe("a");
  });

  it("REVOKE_KEY ends a member's validity and is root-only", () => {
    const revoke: VerifiedEvent<RevokeKeyAction> = ev(
      { t: "REVOKE_KEY", v: 1, ledger: ROSTER, ts: 30, publicKey: "K_a" },
      "K_root",
      30
    );
    const t = replayRoster(ROSTER, [genesis(), attest("K_root", subj("a", "K_a"), 10), revoke]);
    expect(t.memberAt("K_a", 20)?.uid).toBe("a");
    expect(t.memberAt("K_a", 40)).toBeUndefined();
  });

  it("rejects roster actions carrying the wrong ledger id", () => {
    const cross = ev(
      { t: "ATTEST", v: 1, ledger: "OTHER", ts: 20, subject: subj("a", "K_a") },
      "K_root",
      20
    );
    const t = replayRoster(ROSTER, [genesis(), cross]);
    expect(t.anomalies.some((x) => /ledger/i.test(x.reason))).toBe(true);
    expect(t.memberAt("K_a", 30)).toBeUndefined();
  });
});
