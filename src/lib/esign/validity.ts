/**
 * Claim-ledger thread evaluation (docs/ESIGN_DESIGN.md §5.3). Pure and
 * isomorphic. Submissions form threads ordered by signer-committed
 * references (`seq`/`closesRef`), decisions bind thread-locally
 * (`submitRef`), payment latches (`approveRef`) — and settled threads are
 * never invalidated by later events. Timestamps are used ONLY to pick the
 * binding decision among an approver's own conflicting events.
 */

import type {
  ApproveAction,
  ClaimAction,
  MarkPaidAction,
  RejectAction,
  SubmitAction,
  VerifiedEvent,
  WithdrawAction,
} from "./types";
import type { RosterTimeline } from "./roster";

export type ThreadState =
  | "open" // awaiting the named approver
  | "approved"
  | "rejected"
  | "withdrawn"
  | "disputed" // contested seq — requestor-key equivocation (§5.3.3)
  | "paid";

export interface Thread {
  seq: number;
  submit: VerifiedEvent<SubmitAction> | null; // null when disputed
  contested: VerifiedEvent<SubmitAction>[]; // >1 ⇒ disputed
  decision: VerifiedEvent<ApproveAction | RejectAction> | null;
  withdrawals: VerifiedEvent<WithdrawAction>[];
  paid: VerifiedEvent<MarkPaidAction> | null;
  state: ThreadState;
}

export interface ClaimEvaluation {
  threads: Thread[];
  anomalies: { event: VerifiedEvent<ClaimAction>; reason: string }[];
  /** Highest-seq valid thread whose packet hash matches the archived version. */
  currentThread(archivedSha256: string): Thread | undefined;
}

interface Input {
  claimId: string;
  ledgerId: string;
  /** The claim owner's uid — SUBMITs must come from them (server-known). */
  ownerUid: string;
  roster: RosterTimeline;
  events: VerifiedEvent<ClaimAction>[]; // envelope-checked, deduped, ordered
}

/**
 * Action hashes that legally close `thread` for a follow-up SUBMIT carrying
 * `nextSha` (§5.3.2) — the binding REJECT, WITHDRAWs of (each contested)
 * SUBMIT, or the binding APPROVE when the bytes changed. Null when the
 * thread is not closable (open, paid, or approved with the same bytes —
 * the repudiation shape). Exported for the submit preflight, which must
 * stamp the exact `closesRef` the verifier will demand.
 */
export function closureRefs(thread: Thread, nextSha: string): Set<string> | null {
  if (thread.state === "rejected" || thread.state === "withdrawn") {
    return new Set(
      [thread.decision?.actionHash ?? "", ...thread.withdrawals.map((w) => w.actionHash)].filter(
        Boolean
      )
    );
  }
  if (thread.state === "disputed") {
    // Every contested SUBMIT must have been withdrawn; the closure is that
    // full set of WITHDRAW hashes.
    const withdrawn = new Set(
      thread.withdrawals.map((w) => (w.action as WithdrawAction).submitRef)
    );
    const allWithdrawn = thread.contested.every((s) => withdrawn.has(s.actionHash));
    return allWithdrawn ? new Set(thread.withdrawals.map((w) => w.actionHash)) : null;
  }
  if (
    thread.state === "approved" &&
    thread.submit &&
    nextSha !== (thread.submit.action as SubmitAction).packetSha256
  ) {
    // Revert-and-edit flow: an approval closes its thread only for NEW bytes
    // — same-bytes resubmission over an approval is the repudiation shape.
    return thread.decision ? new Set([thread.decision.actionHash]) : null;
  }
  return null; // open / paid / approved-with-same-bytes: not closable
}

export function evaluateClaimLedger(input: Input): ClaimEvaluation {
  const { claimId, ledgerId, ownerUid, roster } = input;
  const anomalies: ClaimEvaluation["anomalies"] = [];
  const bad = (event: VerifiedEvent<ClaimAction>, reason: string) =>
    anomalies.push({ event, reason });

  // Universal envelope-level checks: right ledger, right claim, attested signer.
  const events = input.events.filter((e) => {
    const a = e.action as { ledger?: string; claimId?: string };
    if (a.ledger !== ledgerId) return bad(e, "wrong ledger id"), false;
    if (a.claimId !== claimId) return bad(e, "wrong claim id"), false;
    if (!roster.memberAt(e.signerPublicKey, e.createdAtMs)) {
      return bad(e, "signer not attested at signing time"), false;
    }
    return true;
  });

  const signerUid = (e: VerifiedEvent<ClaimAction>) =>
    roster.memberAt(e.signerPublicKey, e.createdAtMs)!.uid;

  // Candidate SUBMITs that pass local rules (thread structure comes later).
  const submitsBySeq = new Map<number, VerifiedEvent<SubmitAction>[]>();
  const decisions: VerifiedEvent<ApproveAction | RejectAction>[] = [];
  const withdrawals: VerifiedEvent<WithdrawAction>[] = [];
  const paids: VerifiedEvent<MarkPaidAction>[] = [];

  for (const e of events) {
    const a = e.action;
    if (a.t === "SUBMIT") {
      const uid = signerUid(e);
      if (uid !== ownerUid || a.requestorUid !== uid) {
        bad(e, "SUBMIT not signed by the claim owner");
      } else if (a.approverUid === uid) {
        bad(e, "self-approval routing (approver = requestor)");
      } else if (!roster.isApproverAt(a.approverUid, e.createdAtMs)) {
        bad(e, "named approver lacks the approver role");
      } else if (!Number.isInteger(a.seq) || a.seq < 1) {
        bad(e, "bad seq");
      } else {
        const list = submitsBySeq.get(a.seq) ?? [];
        list.push(e as VerifiedEvent<SubmitAction>);
        submitsBySeq.set(a.seq, list);
      }
    } else if (a.t === "APPROVE" || a.t === "REJECT") {
      decisions.push(e as VerifiedEvent<ApproveAction | RejectAction>);
    } else if (a.t === "WITHDRAW") {
      if (signerUid(e) !== ownerUid) bad(e, "WITHDRAW not signed by the claim owner");
      else withdrawals.push(e as VerifiedEvent<WithdrawAction>);
    } else if (a.t === "MARK_PAID") {
      const uid = signerUid(e);
      const rolesOk = roster
        .rolesAt(uid, e.createdAtMs)
        .some((r) => r === "treasurer" || r === "admin");
      if (!rolesOk || a.treasurerUid !== uid) bad(e, "MARK_PAID not signed by a treasurer");
      else paids.push(e as VerifiedEvent<MarkPaidAction>);
    } else {
      bad(e, `unknown claim action ${(a as { t?: string }).t}`);
    }
  }

  // Build threads in seq order. Thread n forms only if thread n−1 is closed
  // and the candidate's closesRef names the exact closing events (§5.3.2).
  const threads: Thread[] = [];
  const maxSeq = Math.max(0, ...submitsBySeq.keys());

  const closureSets = closureRefs;

  for (let seq = 1; seq <= maxSeq; seq++) {
    const candidates = submitsBySeq.get(seq) ?? [];
    const prev = threads[threads.length - 1];

    const structurallyValid = candidates.filter((s) => {
      const a = s.action as SubmitAction;
      const refs = a.closesRef ?? null;
      if (seq === 1) {
        if (refs !== null && refs.length > 0) return bad(s, "seq 1 must not close anything"), false;
        return true;
      }
      if (!prev || prev.seq !== seq - 1) return bad(s, "no preceding thread to close"), false;
      const closure = closureSets(prev, a.packetSha256);
      if (!closure) return bad(s, "previous thread is not closable"), false;
      const got = new Set(refs ?? []);
      if (got.size !== closure.size || [...closure].some((h) => !got.has(h))) {
        return bad(s, "closesRef does not name the closing events exactly"), false;
      }
      return true;
    });

    if (structurallyValid.length === 0) break; // no thread n ⇒ nothing beyond it
    const thread: Thread = {
      seq,
      submit: structurallyValid.length === 1 ? structurallyValid[0] : null,
      contested: structurallyValid,
      decision: null,
      withdrawals: [],
      paid: null,
      state: structurallyValid.length === 1 ? "open" : "disputed",
    };
    threads.push(thread);
    if (thread.state === "disputed") {
      // Withdrawals may still close the dispute for the next seq.
      thread.withdrawals = withdrawals.filter((w) =>
        thread.contested.some((s) => s.actionHash === (w.action as WithdrawAction).submitRef)
      );
      continue;
    }
    const submit = thread.submit!;
    const submitAction = submit.action as SubmitAction;

    // Decisions bound to this SUBMIT, by the named approver, matching bytes.
    const bound = decisions
      .filter((d) => {
        const a = d.action;
        if (a.submitRef !== submit.actionHash) return false;
        if (a.packetSha256 !== submitAction.packetSha256) return bad(d, "decision bytes mismatch"), false;
        const uid = signerUid(d);
        if (uid !== submitAction.approverUid || a.approverUid !== uid) {
          return bad(d, "decision not signed by the named approver"), false;
        }
        return true;
      })
      .sort((x, y) => x.createdAtMs - y.createdAtMs || (x.eventId < y.eventId ? -1 : 1));
    if (bound.length > 0) {
      thread.decision = bound[0];
      for (const extra of bound.slice(1)) {
        if (extra.action.t !== bound[0].action.t) {
          bad(extra, "conflicting later decision — inert (binding decision stands)");
        }
      }
    }

    thread.withdrawals = withdrawals.filter(
      (w) => (w.action as WithdrawAction).submitRef === submit.actionHash
    );

    if (thread.decision?.action.t === "APPROVE") {
      thread.state = "approved";
      for (const w of thread.withdrawals) bad(w, "WITHDRAW after approval is invalid");
      thread.withdrawals = [];
      const paid = paids
        .filter((p) => {
          const a = p.action as MarkPaidAction;
          return (
            a.approveRef === thread.decision!.actionHash &&
            a.packetSha256 === submitAction.packetSha256
          );
        })
        .sort((x, y) => x.createdAtMs - y.createdAtMs || (x.eventId < y.eventId ? -1 : 1));
      if (paid.length > 0) {
        thread.paid = paid[0];
        thread.state = "paid";
      }
    } else if (thread.decision?.action.t === "REJECT") {
      thread.state = "rejected";
    } else if (thread.withdrawals.length > 0) {
      thread.state = "withdrawn";
    }
  }

  // Surface stranded events (referencing no built thread) as anomalies.
  const submitHashes = new Set(threads.flatMap((t) => t.contested.map((s) => s.actionHash)));
  for (const d of decisions) {
    if (!submitHashes.has(d.action.submitRef) && !anomalies.some((x) => x.event === d)) {
      bad(d, "decision references no valid SUBMIT");
    }
  }
  for (const p of paids) {
    const attached = threads.some((t) => t.paid === p || t.decision?.actionHash === (p.action as MarkPaidAction).approveRef);
    if (!attached) bad(p, "MARK_PAID references no binding APPROVE");
  }

  return {
    threads,
    anomalies,
    currentThread(archivedSha256: string) {
      return [...threads]
        .reverse()
        .find((t) => t.submit && (t.submit.action as SubmitAction).packetSha256 === archivedSha256);
    },
  };
}
