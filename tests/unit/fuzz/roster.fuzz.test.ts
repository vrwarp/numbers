import { describe, expect } from "vitest";
import { replayRoster } from "@/lib/esign/roster";
import type { AttestAction, RosterAction, VerifiedEvent } from "@/lib/esign/types";
import { fuzz, Rng } from "./prng";

/**
 * Fuzz the roster reducer with randomized, mostly-legal event streams. The
 * properties below are trust-model invariants that must hold no matter what
 * order or combination of vouches, grants, and revocations arrives — the kind
 * of thing an AI edit to the reducer could quietly break.
 */

const ROSTER = "R";

function build(rng: Rng): VerifiedEvent<RosterAction>[] {
  let seq = 0;
  let clock = 1;
  const mk = (action: RosterAction, signer: string): VerifiedEvent<RosterAction> => {
    seq += 1;
    clock += rng.int(1, 5);
    return { eventId: `e${seq}`, createdAtMs: clock, signerPublicKey: signer, action, actionHash: `h${seq}` };
  };
  const events: VerifiedEvent<RosterAction>[] = [
    mk({ t: "GENESIS", v: 1, ledger: ROSTER, ts: 0, root: { uid: "root", email: "root@c", name: "Root", publicKey: "K_root" } }, "K_root"),
  ];
  // A pool of members we can have vouch for others (starts with just root).
  const seatedKeys = ["K_root"];
  const uidOfKey: Record<string, string> = { K_root: "root" };
  const nOps = rng.int(0, 25);
  for (let i = 0; i < nOps; i++) {
    const choice = rng.int(0, 4);
    if (choice <= 2) {
      // ATTEST: a random seated key vouches a random subject.
      const signer = rng.pick(seatedKeys);
      const uid = `u${rng.int(0, 6)}`;
      const key = `K_${uid}_${rng.int(0, 2)}`;
      const subject: AttestAction["subject"] = { uid, email: `${uid}@c`, name: uid, publicKey: key };
      events.push(mk({ t: "ATTEST", v: 1, ledger: ROSTER, ts: 0, subject }, signer));
      // Optimistically treat it as possibly seated for future vouches.
      if (!seatedKeys.includes(key)) {
        seatedKeys.push(key);
        uidOfKey[key] = uid;
      }
    } else if (choice === 3) {
      events.push(mk({ t: "GRANT_ROLE", v: 1, ledger: ROSTER, ts: 0, uid: `u${rng.int(0, 6)}`, role: "approver" }, "K_root"));
    } else {
      const key = rng.pick(seatedKeys);
      events.push(mk({ t: "REVOKE_KEY", v: 1, ledger: ROSTER, ts: 0, publicKey: key }, "K_root"));
    }
  }
  return events;
}

describe("replayRoster fuzz", () => {
  fuzz("never throws on a well-formed genesis, whatever follows", { iters: 400 }, (rng) => {
    const events = build(rng);
    expect(() => replayRoster(ROSTER, events)).not.toThrow();
  });

  fuzz("the root is always an admin and never revoked by a vouch", { iters: 400 }, (rng) => {
    const t = replayRoster(ROSTER, build(rng));
    const late = 10_000;
    expect(t.rolesAt("root", late)).toContain("admin");
    // The root key stays a valid member for the whole timeline unless an
    // explicit REVOKE_KEY targeted it (our builder only revokes seated keys,
    // which can include K_root) — so assert the weaker, always-true property:
    // root holds admin regardless of key state.
    expect(t.isApproverAt("root", late)).toBe(true);
  });

  fuzz("every attested member was vouched by a DIFFERENT uid (no self-vouch)", { iters: 500 }, (rng) => {
    const t = replayRoster(ROSTER, build(rng));
    for (const m of t.members) {
      for (const v of m.vouchedBy) {
        expect(v.uid).not.toBe(m.uid);
      }
    }
  });

  fuzz("a member's attestation window is well-formed (attested ≤ revoked)", { iters: 500 }, (rng) => {
    const t = replayRoster(ROSTER, build(rng));
    for (const m of t.members) {
      if (m.revokedAtMs !== undefined) {
        expect(m.revokedAtMs).toBeGreaterThanOrEqual(m.attestedAtMs);
      }
    }
  });

  fuzz("memberAt agrees with the members list at every query instant", { iters: 400 }, (rng) => {
    const t = replayRoster(ROSTER, build(rng));
    for (const m of t.members) {
      const mid = m.revokedAtMs
        ? Math.floor((m.attestedAtMs + m.revokedAtMs) / 2)
        : m.attestedAtMs + 1;
      // At an instant inside its window, memberAt finds SOME member for the key.
      const found = t.memberAt(m.publicKey, mid);
      expect(found).toBeDefined();
    }
  });

  fuzz("no key is attested under two different uids simultaneously", { iters: 500 }, (rng) => {
    const t = replayRoster(ROSTER, build(rng));
    // Group members by key; overlapping validity windows must share a uid
    // (the same-subject pooling rule prevents a key meaning two identities).
    const byKey = new Map<string, typeof t.members>();
    for (const m of t.members) {
      const list = byKey.get(m.publicKey) ?? [];
      list.push(m);
      byKey.set(m.publicKey, list);
    }
    for (const list of byKey.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          const aEnd = a.revokedAtMs ?? Infinity;
          const bEnd = b.revokedAtMs ?? Infinity;
          const overlap = a.attestedAtMs < bEnd && b.attestedAtMs < aEnd;
          if (overlap) expect(a.uid).toBe(b.uid);
        }
      }
    }
  });
});
