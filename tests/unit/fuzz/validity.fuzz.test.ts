import { beforeAll, describe, expect } from "vitest";
import { actionHash } from "@/lib/esign/canonical";
import { replayRoster, type RosterTimeline } from "@/lib/esign/roster";
import { evaluateClaimLedger } from "@/lib/esign/validity";
import type {
  ApproveAction,
  ClaimAction,
  MarkPaidAction,
  RejectAction,
  RosterAction,
  SubmitAction,
  VerifiedEvent,
  WithdrawAction,
} from "@/lib/esign/types";
import { fuzz, Rng } from "./prng";

/**
 * Structural fuzz for the claim-ledger thread evaluator. We throw randomized
 * (often malformed, out-of-order, or adversarial) event streams at it and
 * assert the invariants that must hold for ANY input: it never throws, threads
 * are a contiguous 1..n prefix, every thread state is legal, and settled
 * threads/anomalies are surfaced rather than crashing. This is the safety net
 * for AI edits to the reducer.
 */

const ROSTER = "roster-fz";
const rootPK = "PK_root";
const alicePK = "PK_alice"; // owner
const bobPK = "PK_bob"; // approver
const carolPK = "PK_carol"; // treasurer
const CLAIM = "claim-fz";
const LEDGER = "ledger-fz";

let roster: RosterTimeline;

beforeAll(async () => {
  let t = 1000;
  let id = 0;
  const ev = async (pk: string, action: RosterAction): Promise<VerifiedEvent<RosterAction>> => ({
    eventId: `r${id++}`,
    createdAtMs: (t += 1000),
    signerPublicKey: pk,
    action,
    actionHash: await actionHash(action),
  });
  const events = [
    await ev(rootPK, { t: "GENESIS", v: 1, ledger: ROSTER, ts: 1, root: { uid: "root", email: "root@x", name: "Root", publicKey: rootPK } }),
    await ev(rootPK, { t: "ATTEST", v: 1, ledger: ROSTER, ts: 1, subject: { uid: "alice", email: "a@x", name: "Alice", publicKey: alicePK } }),
    await ev(rootPK, { t: "ATTEST", v: 1, ledger: ROSTER, ts: 1, subject: { uid: "bob", email: "b@x", name: "Bob", publicKey: bobPK } }),
    await ev(rootPK, { t: "ATTEST", v: 1, ledger: ROSTER, ts: 1, subject: { uid: "carol", email: "c@x", name: "Carol", publicKey: carolPK } }),
    await ev(rootPK, { t: "GRANT_ROLE", v: 1, ledger: ROSTER, ts: 1, uid: "bob", role: "approver" }),
    await ev(rootPK, { t: "GRANT_ROLE", v: 1, ledger: ROSTER, ts: 1, uid: "carol", role: "treasurer" }),
  ];
  roster = replayRoster(ROSTER, events);
});

const LEGAL_STATES = new Set(["open", "approved", "rejected", "withdrawn", "disputed", "paid"]);

async function mk(rng: Rng, pk: string, action: ClaimAction, tMs: number): Promise<VerifiedEvent<ClaimAction>> {
  return {
    eventId: `c${rng.int(0, 1_000_000)}-${tMs}`,
    createdAtMs: tMs,
    signerPublicKey: pk,
    action,
    actionHash: await actionHash(action),
  };
}

async function randomLedger(rng: Rng): Promise<VerifiedEvent<ClaimAction>[]> {
  const events: VerifiedEvent<ClaimAction>[] = [];
  let clock = 100_000;
  const signers = [alicePK, bobPK, carolPK, rootPK, "PK_ghost"];
  const shas = ["sha-A", "sha-B", "sha-C"];
  const knownHashes: string[] = [];
  const n = rng.int(0, 14);
  for (let i = 0; i < n; i++) {
    clock += rng.int(1, 50);
    const pk = rng.pick(signers);
    const kind = rng.int(0, 4);
    let action: ClaimAction;
    if (kind === 0) {
      action = {
        t: "SUBMIT", v: 1, ledger: LEDGER, ts: clock,
        seq: rng.int(1, 4),
        closesRef: rng.bool(0.5) ? (rng.bool() ? [rng.pick(knownHashes.length ? knownHashes : ["x"])] : null) : null,
        claimId: CLAIM, packetSha256: rng.pick(shas), rowsDigest: "rows",
        totalCents: rng.int(0, 100000), requestorUid: rng.pick(["alice", "bob"]),
        approverUid: rng.pick(["bob", "carol", "alice"]),
        typedName: "Alice", consentVersion: "1", consentSha256: "cs",
      } as SubmitAction;
    } else if (kind === 1) {
      action = {
        t: "APPROVE", v: 1, ledger: LEDGER, ts: clock, claimId: CLAIM,
        packetSha256: rng.pick(shas), submitRef: rng.pick(knownHashes.length ? knownHashes : ["x"]),
        approverUid: rng.pick(["bob", "carol"]), typedName: "Bob", consentVersion: "1", consentSha256: "cs", comment: "",
      } as ApproveAction;
    } else if (kind === 2) {
      action = {
        t: "REJECT", v: 1, ledger: LEDGER, ts: clock, claimId: CLAIM,
        packetSha256: rng.pick(shas), submitRef: rng.pick(knownHashes.length ? knownHashes : ["x"]),
        approverUid: rng.pick(["bob", "carol"]), comment: "no",
      } as RejectAction;
    } else if (kind === 3) {
      action = {
        t: "WITHDRAW", v: 1, ledger: LEDGER, ts: clock, claimId: CLAIM,
        submitRef: rng.pick(knownHashes.length ? knownHashes : ["x"]),
      } as WithdrawAction;
    } else {
      action = {
        t: "MARK_PAID", v: 1, ledger: LEDGER, ts: clock, claimId: CLAIM,
        packetSha256: rng.pick(shas), approveRef: rng.pick(knownHashes.length ? knownHashes : ["x"]),
        treasurerUid: rng.pick(["carol", "bob"]), typedName: "Carol", consentVersion: "1", consentSha256: "cs", checkNumber: "123",
      } as MarkPaidAction;
    }
    const e = await mk(rng, pk, action, clock);
    events.push(e);
    knownHashes.push(e.actionHash);
  }
  // Occasionally shuffle to exercise ordering robustness (evaluator re-sorts).
  return rng.bool(0.3) ? rng.shuffle(events) : events;
}

describe("evaluateClaimLedger fuzz", () => {
  fuzz("never throws and returns a well-formed evaluation", { iters: 250 }, async (rng) => {
    const events = await randomLedger(rng);
    const result = evaluateClaimLedger({ claimId: CLAIM, ledgerId: LEDGER, ownerUid: "alice", roster, events });
    expect(Array.isArray(result.threads)).toBe(true);
    expect(Array.isArray(result.anomalies)).toBe(true);
    expect(typeof result.currentThread).toBe("function");
  });

  fuzz("threads form a contiguous 1..n prefix with legal states", { iters: 250 }, async (rng) => {
    const events = await randomLedger(rng);
    const { threads } = evaluateClaimLedger({ claimId: CLAIM, ledgerId: LEDGER, ownerUid: "alice", roster, events });
    threads.forEach((thread, i) => {
      expect(thread.seq).toBe(i + 1);
      expect(LEGAL_STATES.has(thread.state)).toBe(true);
      // A non-disputed thread has exactly one submit; a disputed one has none but >1 contested.
      if (thread.state === "disputed") {
        expect(thread.submit).toBeNull();
        expect(thread.contested.length).toBeGreaterThan(1);
      } else {
        expect(thread.submit).not.toBeNull();
      }
      // paid implies an approve decision is bound.
      if (thread.state === "paid") {
        expect(thread.decision?.action.t).toBe("APPROVE");
        expect(thread.paid).not.toBeNull();
      }
    });
  });

  fuzz("currentThread only ever returns a thread whose submit matches the sha", { iters: 200 }, async (rng) => {
    const events = await randomLedger(rng);
    const evalr = evaluateClaimLedger({ claimId: CLAIM, ledgerId: LEDGER, ownerUid: "alice", roster, events });
    for (const sha of ["sha-A", "sha-B", "sha-C", "sha-missing"]) {
      const cur = evalr.currentThread(sha);
      if (cur) {
        expect((cur.submit!.action as SubmitAction).packetSha256).toBe(sha);
      }
    }
  });

  fuzz("evaluation is invariant to input event ordering", { iters: 150 }, async (rng) => {
    const events = await randomLedger(rng);
    const a = evaluateClaimLedger({ claimId: CLAIM, ledgerId: LEDGER, ownerUid: "alice", roster, events });
    const b = evaluateClaimLedger({ claimId: CLAIM, ledgerId: LEDGER, ownerUid: "alice", roster, events: rng.shuffle(events) });
    expect(b.threads.map((t) => `${t.seq}:${t.state}`)).toEqual(a.threads.map((t) => `${t.seq}:${t.state}`));
  });
});
