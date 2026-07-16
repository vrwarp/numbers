import { describe, expect } from "vitest";
import { computeLineItemChanges } from "@/lib/audit";
import { fuzz, Rng } from "./prng";

/**
 * computeLineItemChanges backs the review-edit audit trail (invariant 7). Its
 * contract: report exactly the tracked fields whose value the patch changes,
 * with correct {from,to}, and ignore everything else. A regression here
 * silently corrupts the human-correction record used for prompt tuning.
 */
const TRACKED = ["description", "amountCents", "ministry", "event", "isVerified", "isExcluded"] as const;

function randomRow(rng: Rng): Record<string, unknown> {
  return {
    description: rng.pick(["a", "b", "c"]),
    amountCents: rng.int(-500, 500),
    ministry: rng.pick(["", "210 X", "300 Y"]),
    event: rng.pick(["", "VBS"]),
    isVerified: rng.bool(),
    isExcluded: rng.bool(),
    // An untracked field that must never appear in the diff.
    receiptId: rng.pick(["r1", "r2"]),
  };
}

function randomPatch(rng: Rng): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const f of TRACKED) {
    if (rng.bool(0.5)) continue; // partial patch
    switch (f) {
      case "amountCents":
        patch[f] = rng.int(-500, 500);
        break;
      case "isVerified":
      case "isExcluded":
        patch[f] = rng.bool();
        break;
      default:
        patch[f] = rng.pick(["", "a", "b", "c", "210 X", "VBS"]);
    }
  }
  if (rng.bool(0.3)) patch.receiptId = "r9"; // untracked, must be ignored
  return patch;
}

describe("computeLineItemChanges fuzz", () => {
  fuzz("reports exactly the tracked fields that actually change", { iters: 600 }, (rng) => {
    const before = randomRow(rng);
    const patch = randomPatch(rng);
    const changes = computeLineItemChanges(before, patch);

    for (const f of TRACKED) {
      const present = patch[f] !== undefined;
      const changed = present && patch[f] !== before[f];
      if (changed) {
        expect(changes[f]).toEqual({ from: before[f], to: patch[f] });
      } else {
        expect(f in changes).toBe(false);
      }
    }
  });

  fuzz("never reports untracked fields", { iters: 300 }, (rng) => {
    const changes = computeLineItemChanges(randomRow(rng), randomPatch(rng));
    expect("receiptId" in changes).toBe(false);
    for (const key of Object.keys(changes)) {
      expect(TRACKED).toContain(key as (typeof TRACKED)[number]);
    }
  });

  fuzz("an empty patch produces no changes", { iters: 100 }, (rng) => {
    expect(computeLineItemChanges(randomRow(rng), {})).toEqual({});
  });

  fuzz("a patch equal to the row produces no changes", { iters: 200 }, (rng) => {
    const before = randomRow(rng);
    const patch: Record<string, unknown> = {};
    for (const f of TRACKED) patch[f] = before[f];
    expect(computeLineItemChanges(before, patch)).toEqual({});
  });
});
