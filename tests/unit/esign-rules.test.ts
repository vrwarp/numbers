import { beforeAll, describe, expect, it } from "vitest";
import { actionHash } from "@/lib/esign/canonical";
import { replayRoster, type RosterTimeline } from "@/lib/esign/roster";
import { evaluateClaimLedger } from "@/lib/esign/validity";
import type {
  ClaimAction,
  RosterAction,
  SubmitAction,
  VerifiedEvent,
} from "@/lib/esign/types";

// Reducers consume envelope-verified events, so tests build VerifiedEvent
// objects directly (crypto is covered by esign-core.test.ts). Only the
// actionHash must be real — refs depend on it.
let nextT = 1000;
let nextId = 0;
async function ev<A extends RosterAction | ClaimAction>(
  signerPublicKey: string,
  action: A
): Promise<VerifiedEvent<A>> {
  nextT += 1000;
  return {
    eventId: `e${nextId++}`,
    createdAtMs: nextT,
    signerPublicKey,
    action,
    actionHash: await actionHash(action),
  };
}

const ROSTER = "roster-1";
const rootPK = "PK_root";
const alicePK = "PK_alice";
const bobPK = "PK_bob";
const carolPK = "PK_carol";
const malloryPK = "PK_mallory";

const genesis = (): RosterAction => ({
  t: "GENESIS",
  v: 1,
  ledger: ROSTER,
  ts: 1,
  root: { uid: "root", email: "root@x", name: "Root", publicKey: rootPK },
});
const attest = (subject: { uid: string; publicKey: string }, name = subject.uid): RosterAction => ({
  t: "ATTEST",
  v: 1,
  ledger: ROSTER,
  ts: 1,
  subject: { uid: subject.uid, email: `${subject.uid}@x`, name, publicKey: subject.publicKey },
});
const grant = (uid: string, role: "approver" | "treasurer" | "admin"): RosterAction => ({
  t: "GRANT_ROLE",
  v: 1,
  ledger: ROSTER,
  ts: 1,
  uid,
  role,
});

async function standardRoster(): Promise<RosterTimeline> {
  const events = [
    await ev(rootPK, genesis()),
    // Root is approver+ ⇒ one vouch attests each member instantly.
    await ev(rootPK, attest({ uid: "alice", publicKey: alicePK })),
    await ev(rootPK, attest({ uid: "bob", publicKey: bobPK })),
    await ev(rootPK, attest({ uid: "carol", publicKey: carolPK })),
    await ev(rootPK, grant("bob", "approver")),
    await ev(rootPK, grant("carol", "treasurer")),
  ];
  return replayRoster(ROSTER, events as VerifiedEvent<RosterAction>[]);
}

describe("roster reducer", () => {
  it("rejects a roster whose genesis is not self-signed by the root", async () => {
    const bad = await ev(malloryPK, genesis());
    expect(() => replayRoster(ROSTER, [bad as VerifiedEvent<RosterAction>])).toThrow(/genesis/i);
  });

  it("attests after two distinct member vouches, not one, not self", async () => {
    const events = [
      await ev(rootPK, genesis()),
      await ev(rootPK, attest({ uid: "alice", publicKey: alicePK })),
      await ev(rootPK, attest({ uid: "bob", publicKey: bobPK })),
      // Unattested Mallory vouching for herself fails the attested-voucher gate;
      // attested Alice vouching her OWN second key hits the self-vouch rule.
      await ev(malloryPK, attest({ uid: "mallory", publicKey: malloryPK })),
      await ev(alicePK, attest({ uid: "alice", publicKey: "PK_alice2" })),
      // One alice vouch for mallory: pending until a second distinct voucher.
      await ev(alicePK, attest({ uid: "mallory", publicKey: malloryPK })),
    ];
    let roster = replayRoster(ROSTER, events as VerifiedEvent<RosterAction>[]);
    expect(roster.memberAt(malloryPK, nextT + 1)).toBeUndefined();
    expect(roster.memberAt("PK_alice2", nextT + 1)).toBeUndefined();
    expect(roster.anomalies.some((a) => /not an attested member/.test(a.reason))).toBe(true);
    expect(roster.anomalies.some((a) => /self-vouch/i.test(a.reason))).toBe(true);

    const second = await ev(bobPK, attest({ uid: "mallory", publicKey: malloryPK }));
    roster = replayRoster(ROSTER, [...events, second] as VerifiedEvent<RosterAction>[]);
    const m = roster.memberAt(malloryPK, nextT + 1);
    expect(m?.uid).toBe("mallory");
    // Attested at the SECOND vouch's time, not the first.
    expect(m?.attestedAtMs).toBe(second.createdAtMs);
    // A duplicate vouch from the same voucher must never tip the threshold.
    expect(
      replayRoster(ROSTER, [
        events[0],
        events[1],
        events[2],
        await ev(alicePK, attest({ uid: "zed", publicKey: "PK_zed" })),
        await ev(alicePK, attest({ uid: "zed", publicKey: "PK_zed", }, "Zed")),
      ] as VerifiedEvent<RosterAction>[]).memberAt("PK_zed", nextT + 1)
    ).toBeUndefined();
  });

  it("role grants are root-only and time-scoped; key revocation is forward-only", async () => {
    const base = [
      await ev(rootPK, genesis()),
      await ev(rootPK, attest({ uid: "alice", publicKey: alicePK })),
      await ev(rootPK, attest({ uid: "bob", publicKey: bobPK })),
    ];
    const fakeGrant = await ev(alicePK, grant("alice", "treasurer"));
    const realGrant = await ev(rootPK, grant("bob", "approver"));
    const revoke = await ev(rootPK, {
      t: "REVOKE_KEY",
      v: 1,
      ledger: ROSTER,
      ts: 1,
      publicKey: alicePK,
    } as RosterAction);
    const roster = replayRoster(ROSTER, [...base, fakeGrant, realGrant, revoke] as VerifiedEvent<RosterAction>[]);
    expect(roster.rolesAt("alice", nextT + 1)).toEqual([]);
    expect(roster.isApproverAt("bob", nextT + 1)).toBe(true);
    expect(roster.isApproverAt("bob", realGrant.createdAtMs - 1)).toBe(false);
    // Alice's key: attested before revocation, gone after.
    expect(roster.memberAt(alicePK, revoke.createdAtMs - 1)?.uid).toBe("alice");
    expect(roster.memberAt(alicePK, revoke.createdAtMs + 1)).toBeUndefined();
    expect(roster.anomalies.some((a) => /not signed by the root/.test(a.reason))).toBe(true);
  });
});

// --- Claim thread rules ------------------------------------------------------

const CLAIM = "claim-1";
const LEDGER = "ledger-1";

function submit(over: Partial<SubmitAction>): SubmitAction {
  return {
    t: "SUBMIT",
    v: 1,
    ledger: LEDGER,
    ts: 1,
    seq: 1,
    closesRef: null,
    claimId: CLAIM,
    packetSha256: "sha-A",
    rowsDigest: "rows-A",
    totalCents: 5000,
    requestorUid: "alice",
    approverUid: "bob",
    typedName: "Alice",
    consentVersion: "ueta-v1",
    consentSha256: "c",
    ...over,
  };
}
const approve = (submitRef: string, over: Record<string, unknown> = {}): ClaimAction =>
  ({
    t: "APPROVE",
    v: 1,
    ledger: LEDGER,
    ts: 1,
    claimId: CLAIM,
    packetSha256: "sha-A",
    submitRef,
    approverUid: "bob",
    typedName: "Bob",
    consentVersion: "ueta-v1",
    consentSha256: "c",
    comment: "",
    ...over,
  }) as ClaimAction;
const reject = (submitRef: string): ClaimAction =>
  ({
    t: "REJECT",
    v: 1,
    ledger: LEDGER,
    ts: 1,
    claimId: CLAIM,
    packetSha256: "sha-A",
    submitRef,
    approverUid: "bob",
    comment: "nope",
  }) as ClaimAction;
const withdraw = (submitRef: string): ClaimAction =>
  ({ t: "WITHDRAW", v: 1, ledger: LEDGER, ts: 1, claimId: CLAIM, submitRef }) as ClaimAction;
const paid = (approveRef: string, sha = "sha-A"): ClaimAction =>
  ({
    t: "MARK_PAID",
    v: 1,
    ledger: LEDGER,
    ts: 1,
    claimId: CLAIM,
    packetSha256: sha,
    approveRef,
    treasurerUid: "carol",
    typedName: "Carol",
    consentVersion: "ueta-v1",
    consentSha256: "c",
    checkNumber: "1042",
  }) as ClaimAction;

let roster: RosterTimeline;
beforeAll(async () => {
  roster = await standardRoster();
});

function evaluate(events: VerifiedEvent<ClaimAction>[]) {
  return evaluateClaimLedger({ claimId: CLAIM, ledgerId: LEDGER, ownerUid: "alice", roster, events });
}

describe("claim thread validity", () => {
  it("submit → approve → paid settles the thread", async () => {
    const s1 = await ev(alicePK, submit({}));
    const a1 = await ev(bobPK, approve(s1.actionHash));
    const p1 = await ev(carolPK, paid(a1.actionHash));
    const out = evaluate([s1, a1, p1] as VerifiedEvent<ClaimAction>[]);
    expect(out.threads).toHaveLength(1);
    expect(out.threads[0].state).toBe("paid");
    expect(out.currentThread("sha-A")?.seq).toBe(1);
    expect(out.anomalies).toHaveLength(0);
  });

  it("reject → resubmit(closesRef) → approve works; stale approve of thread 1 cannot bind thread 2", async () => {
    const s1 = await ev(alicePK, submit({}));
    const r1 = await ev(bobPK, reject(s1.actionHash));
    const s2 = await ev(alicePK, submit({ seq: 2, closesRef: [r1.actionHash] }));
    const staleApprove = await ev(bobPK, approve(s1.actionHash)); // late approve of rejected thread
    const a2 = await ev(bobPK, approve(s2.actionHash));
    const out = evaluate([s1, r1, s2, staleApprove, a2] as VerifiedEvent<ClaimAction>[]);
    expect(out.threads.map((t) => t.state)).toEqual(["rejected", "approved"]);
    // The stale approve is inert: thread 1's binding decision stays REJECT.
    expect(out.threads[0].decision!.action.t).toBe("REJECT");
    expect(out.anomalies.some((a) => /conflicting later decision/.test(a.reason))).toBe(true);
  });

  it("REPUDIATION BLOCKED: a paid thread is immune to a later same-bytes SUBMIT", async () => {
    const s1 = await ev(alicePK, submit({}));
    const a1 = await ev(bobPK, approve(s1.actionHash));
    const p1 = await ev(carolPK, paid(a1.actionHash));
    // Attacker (the paid requestor) tries seq 2 with the same bytes, claiming
    // the APPROVE as closure — §5.3.2 forbids same-bytes closure via APPROVE.
    const s2 = await ev(alicePK, submit({ seq: 2, closesRef: [a1.actionHash] }));
    const out = evaluate([s1, a1, p1, s2] as VerifiedEvent<ClaimAction>[]);
    expect(out.threads).toHaveLength(1);
    expect(out.threads[0].state).toBe("paid");
    expect(out.anomalies.some((a) => /not closable/.test(a.reason))).toBe(true);
  });

  it("revert-and-edit: new bytes may open thread 2 over an approval without touching thread 1", async () => {
    const s1 = await ev(alicePK, submit({}));
    const a1 = await ev(bobPK, approve(s1.actionHash));
    const s2 = await ev(alicePK, submit({ seq: 2, closesRef: [a1.actionHash], packetSha256: "sha-B", rowsDigest: "rows-B" }));
    const out = evaluate([s1, a1, s2] as VerifiedEvent<ClaimAction>[]);
    expect(out.threads.map((t) => t.state)).toEqual(["approved", "open"]);
    expect(out.currentThread("sha-B")?.seq).toBe(2);
    expect(out.currentThread("sha-A")?.seq).toBe(1);
  });

  it("withdraw + resubmit reassigns the approver with the same bytes", async () => {
    const rosterWithDan = replayRoster(ROSTER, [
      await ev(rootPK, genesis()),
      await ev(rootPK, attest({ uid: "alice", publicKey: alicePK })),
      await ev(rootPK, attest({ uid: "bob", publicKey: bobPK })),
      await ev(rootPK, attest({ uid: "dan", publicKey: "PK_dan" })),
      await ev(rootPK, grant("bob", "approver")),
      await ev(rootPK, grant("dan", "approver")),
    ] as VerifiedEvent<RosterAction>[]);
    const s1 = await ev(alicePK, submit({}));
    const w1 = await ev(alicePK, withdraw(s1.actionHash));
    const s2 = await ev(alicePK, submit({ seq: 2, closesRef: [w1.actionHash], approverUid: "dan" }));
    const out = evaluateClaimLedger({
      claimId: CLAIM,
      ledgerId: LEDGER,
      ownerUid: "alice",
      roster: rosterWithDan,
      events: [s1, w1, s2] as VerifiedEvent<ClaimAction>[],
    });
    expect(out.threads.map((t) => t.state)).toEqual(["withdrawn", "open"]);
    expect((out.threads[1].submit!.action as SubmitAction).approverUid).toBe("dan");
  });

  it("contested seq disputes only that thread; withdrawing both contested submits recovers", async () => {
    const s1 = await ev(alicePK, submit({}));
    const a1 = await ev(bobPK, approve(s1.actionHash));
    const s2x = await ev(alicePK, submit({ seq: 2, closesRef: [a1.actionHash], packetSha256: "sha-B", approverUid: "bob" }));
    const s2y = await ev(alicePK, submit({ seq: 2, closesRef: [a1.actionHash], packetSha256: "sha-C", approverUid: "bob" }));
    let out = evaluate([s1, a1, s2x, s2y] as VerifiedEvent<ClaimAction>[]);
    expect(out.threads.map((t) => t.state)).toEqual(["approved", "disputed"]);

    const w2x = await ev(alicePK, withdraw(s2x.actionHash));
    const w2y = await ev(alicePK, withdraw(s2y.actionHash));
    const s3 = await ev(alicePK, submit({ seq: 3, closesRef: [w2x.actionHash, w2y.actionHash], packetSha256: "sha-D" }));
    out = evaluate([s1, a1, s2x, s2y, w2x, w2y, s3] as VerifiedEvent<ClaimAction>[]);
    expect(out.threads.map((t) => t.state)).toEqual(["approved", "disputed", "open"]);
  });

  it("enforces signer identity/role rules", async () => {
    // Approver = requestor is invalid routing.
    const selfRoute = await ev(alicePK, submit({ approverUid: "alice" }));
    // Mallory (unattested) signing anything is dropped at the envelope gate.
    const ghost = await ev(malloryPK, submit({}));
    // A decision from someone other than the named approver never binds.
    const s1 = await ev(alicePK, submit({}));
    const impostor = await ev(carolPK, approve(s1.actionHash, { approverUid: "carol" }));
    // MARK_PAID from a non-treasurer never counts.
    const a1 = await ev(bobPK, approve(s1.actionHash));
    const fakePaid = await ev(bobPK, { ...(paid(a1.actionHash) as object), treasurerUid: "bob" } as ClaimAction);
    // WITHDRAW after approval is invalid.
    const lateWithdraw = await ev(alicePK, withdraw(s1.actionHash));

    const out = evaluate([selfRoute, ghost, s1, impostor, a1, fakePaid, lateWithdraw] as VerifiedEvent<ClaimAction>[]);
    expect(out.threads).toHaveLength(1);
    expect(out.threads[0].state).toBe("approved");
    expect(out.threads[0].paid).toBeNull();
    const reasons = out.anomalies.map((a) => a.reason).join("\n");
    expect(reasons).toMatch(/self-approval routing/);
    expect(reasons).toMatch(/not attested/);
    expect(reasons).toMatch(/not signed by the named approver/);
    expect(reasons).toMatch(/not signed by a treasurer/);
    expect(reasons).toMatch(/WITHDRAW after approval/);
  });
});

describe("key supersession (§4.5 — re-vouching is the lost-device recovery)", () => {
  it("a newly attested key retires the uid's old key at that instant; history stands", async () => {
    const g = await ev(rootPK, genesis());
    const a1 = await ev(rootPK, attest({ uid: "alice", publicKey: alicePK }));
    const b1 = await ev(rootPK, attest({ uid: "bob", publicKey: bobPK }));
    const gb = await ev(rootPK, grant("bob", "approver"));
    // Alice lost everything: new key, one approver vouch tips it.
    const rekey = await ev(bobPK, attest({ uid: "alice", publicKey: "PK_alice2" }));
    const roster = replayRoster(ROSTER, [g, a1, b1, gb, rekey] as VerifiedEvent<RosterAction>[]);

    // Before the re-vouch the old key is valid — repudiation-proofing.
    expect(roster.memberAt(alicePK, rekey.createdAtMs - 1)?.uid).toBe("alice");
    // From the re-vouch on, only the new key counts.
    expect(roster.memberAt(alicePK, rekey.createdAtMs + 1)).toBeUndefined();
    expect(roster.memberAt("PK_alice2", rekey.createdAtMs + 1)?.uid).toBe("alice");
    const old = roster.members.find((m) => m.publicKey === alicePK);
    expect(old?.revokedAtMs).toBe(rekey.createdAtMs);
    expect(roster.anomalies).toHaveLength(0);

    // Deliberately re-vouching the ORIGINAL key restores it and retires the
    // replacement — the quorum always speaks last.
    const restore = await ev(bobPK, attest({ uid: "alice", publicKey: alicePK }));
    const roster2 = replayRoster(ROSTER, [g, a1, b1, gb, rekey, restore] as VerifiedEvent<RosterAction>[]);
    expect(roster2.memberAt(alicePK, restore.createdAtMs + 1)?.uid).toBe("alice");
    expect(roster2.memberAt("PK_alice2", restore.createdAtMs + 1)).toBeUndefined();
    // The middle window still belongs to the replacement key.
    expect(roster2.memberAt("PK_alice2", restore.createdAtMs - 1)?.uid).toBe("alice");
  });

  it("supersedes on the two-member path too, at the tipping vouch's time", async () => {
    const g = await ev(rootPK, genesis());
    const a1 = await ev(rootPK, attest({ uid: "alice", publicKey: alicePK }));
    const b1 = await ev(rootPK, attest({ uid: "bob", publicKey: bobPK }));
    const m1 = await ev(alicePK, attest({ uid: "mallory", publicKey: malloryPK }));
    const m2 = await ev(bobPK, attest({ uid: "mallory", publicKey: malloryPK }));
    // Mallory re-keys with two plain-member vouches.
    const r1 = await ev(alicePK, attest({ uid: "mallory", publicKey: "PK_mallory2" }));
    const roster1 = replayRoster(ROSTER, [g, a1, b1, m1, m2, r1] as VerifiedEvent<RosterAction>[]);
    // One vouch: nothing supersedes yet.
    expect(roster1.memberAt(malloryPK, r1.createdAtMs + 1)?.uid).toBe("mallory");

    const r2 = await ev(bobPK, attest({ uid: "mallory", publicKey: "PK_mallory2" }));
    const roster2 = replayRoster(ROSTER, [g, a1, b1, m1, m2, r1, r2] as VerifiedEvent<RosterAction>[]);
    expect(roster2.memberAt(malloryPK, r2.createdAtMs + 1)).toBeUndefined();
    expect(roster2.memberAt("PK_mallory2", r2.createdAtMs + 1)?.attestedAtMs).toBe(r2.createdAtMs);
  });

  it("the root key can never be superseded by vouching", async () => {
    const g = await ev(rootPK, genesis());
    const a1 = await ev(rootPK, attest({ uid: "alice", publicKey: alicePK }));
    const b1 = await ev(rootPK, attest({ uid: "bob", publicKey: bobPK }));
    const takeover1 = await ev(alicePK, attest({ uid: "root", publicKey: "PK_root2" }));
    const takeover2 = await ev(bobPK, attest({ uid: "root", publicKey: "PK_root2" }));
    const roster = replayRoster(ROSTER, [g, a1, b1, takeover1, takeover2] as VerifiedEvent<RosterAction>[]);
    expect(roster.memberAt("PK_root2", takeover2.createdAtMs + 1)).toBeUndefined();
    // The anchor is untouched and both attempts are surfaced loudly.
    expect(roster.memberAt(rootPK, takeover2.createdAtMs + 1)?.uid).toBe("root");
    expect(roster.anomalies.filter((a) => /fixed by genesis/.test(a.reason))).toHaveLength(2);
  });
});
