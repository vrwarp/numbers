import { describe, expect, it } from "vitest";
import {
  ANNOTATION_MAX_ATTEMPTS,
  annotationRetryPlan,
  paceWaitMs,
} from "@/lib/extraction/retry";

const NOW = 1_700_000_000_000;

describe("annotationRetryPlan", () => {
  it("re-queues a quota failure after the cooldown WITHOUT burning an attempt", () => {
    const plan = annotationRetryPlan({
      attempts: 3,
      isQuota: true,
      quotaCooldownMs: 60_000,
      now: NOW,
    });
    expect(plan).toEqual({
      kind: "requeue",
      attempts: 3,
      nextAttemptAt: new Date(NOW + 60_000),
    });
  });

  it("floors the quota cooldown so a 0 config can't hot-loop the worker", () => {
    const plan = annotationRetryPlan({ attempts: 0, isQuota: true, quotaCooldownMs: 0, now: NOW });
    expect(plan.kind).toBe("requeue");
    if (plan.kind === "requeue") {
      expect(plan.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(NOW + 1_000);
    }
  });

  it("burns an attempt with exponential backoff on a real error", () => {
    const first = annotationRetryPlan({ attempts: 0, isQuota: false, quotaCooldownMs: 60_000, now: NOW });
    expect(first).toEqual({ kind: "requeue", attempts: 1, nextAttemptAt: new Date(NOW + 60_000) });
    const second = annotationRetryPlan({ attempts: 1, isQuota: false, quotaCooldownMs: 60_000, now: NOW });
    expect(second).toEqual({ kind: "requeue", attempts: 2, nextAttemptAt: new Date(NOW + 120_000) });
  });

  it("fails terminally once the attempt budget is spent", () => {
    const plan = annotationRetryPlan({
      attempts: ANNOTATION_MAX_ATTEMPTS - 1,
      isQuota: false,
      quotaCooldownMs: 60_000,
      now: NOW,
    });
    expect(plan).toEqual({ kind: "failed", attempts: ANNOTATION_MAX_ATTEMPTS });
  });

  it("never fails terminally on quota errors — the drip just keeps waiting", () => {
    const plan = annotationRetryPlan({
      attempts: ANNOTATION_MAX_ATTEMPTS + 10,
      isQuota: true,
      quotaCooldownMs: 60_000,
      now: NOW,
    });
    expect(plan.kind).toBe("requeue");
  });
});

describe("paceWaitMs (the ≤1-receipt-per-minute drip)", () => {
  it("treats an unset last-call time as clear-to-call (the worker seeds it at boot, so a real first call still waits out the pace)", () => {
    expect(paceWaitMs(0, NOW, 60_000)).toBe(0);
  });

  it("holds the next call until the pace window closes", () => {
    expect(paceWaitMs(NOW, NOW + 10_000, 60_000)).toBe(50_000);
    expect(paceWaitMs(NOW, NOW + 60_000, 60_000)).toBe(0);
    expect(paceWaitMs(NOW, NOW + 90_000, 60_000)).toBe(0);
  });

  it("a pace of 0 disables the drip (tests / e2e)", () => {
    expect(paceWaitMs(NOW, NOW + 1, 0)).toBe(0);
  });
});
