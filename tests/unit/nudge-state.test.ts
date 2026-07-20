import { describe, expect, it } from "vitest";
import {
  DUTY_SNOOZE_CAP,
  dutyCardCollapsed,
  memberCardCollapsed,
  mergeNudgeState,
  parseNudgeState,
  pendingStale,
} from "@/lib/esign/nudge-state";

const NOW = new Date("2026-07-19T10:00:00Z");
const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("parseNudgeState", () => {
  it("degrades corrupt/absent JSON to {} (never invents marks)", () => {
    expect(parseNudgeState(null)).toEqual({});
    expect(parseNudgeState("")).toEqual({});
    expect(parseNudgeState("not json")).toEqual({});
    expect(parseNudgeState("[1,2]")).toEqual({});
    expect(parseNudgeState('"str"')).toEqual({});
  });
  it("passes objects through", () => {
    expect(parseNudgeState('{"declined":true}')).toEqual({ declined: true });
  });
});

describe("mergeNudgeState — the consent record must be durable", () => {
  it("is monotonic: a stale tab replay cannot resurrect a decline", () => {
    const declined = mergeNudgeState({}, { declined: true }, NOW);
    expect(declined.declined).toBe(true);
    // A second tab that loaded before the decline sends only its own intent —
    // the merge starts from the STORED state, so the decline survives.
    const other = mergeNudgeState(declined, { firstSeenMember: true }, NOW);
    expect(other.declined).toBe(true);
    expect(other.firstSeenMember).toBe(NOW.toISOString());
  });

  it("keeps the earliest firstSeen (decay anchor is idempotent)", () => {
    const first = mergeNudgeState({}, { firstSeenMember: true }, days(5));
    const again = mergeNudgeState(first, { firstSeenMember: true }, NOW);
    expect(again.firstSeenMember).toBe(days(5).toISOString());
  });

  it("grows the snooze counter and caps it", () => {
    let s = {};
    for (let i = 0; i < DUTY_SNOOZE_CAP + 3; i++) s = mergeNudgeState(s, { dutySnooze: true }, NOW);
    expect((s as { dutySnoozeCount?: number }).dutySnoozeCount).toBe(DUTY_SNOOZE_CAP);
  });

  it("preserves unknown keys verbatim (forward compat)", () => {
    const merged = mergeNudgeState({ futureKey: { a: 1 } }, { closureShown: true }, NOW);
    expect(merged.futureKey).toEqual({ a: 1 });
    expect(merged.closureShown).toBe(true);
  });
});

describe("decay predicates", () => {
  it("member card collapses after 21 days seen", () => {
    expect(memberCardCollapsed({ firstSeenMember: days(20).toISOString() }, NOW)).toBe(false);
    expect(memberCardCollapsed({ firstSeenMember: days(22).toISOString() }, NOW)).toBe(true);
    expect(memberCardCollapsed({}, NOW)).toBe(false);
  });
  it("pending goes stale after 14 days", () => {
    expect(pendingStale(days(13), NOW)).toBe(false);
    expect(pendingStale(days(15), NOW)).toBe(true);
    expect(pendingStale(null, NOW)).toBe(false);
  });
  it("duty card: visible → snoozed → capped chip", () => {
    expect(dutyCardCollapsed({}, NOW)).toBe("no");
    const snoozed = mergeNudgeState({}, { dutySnooze: true }, NOW);
    expect(dutyCardCollapsed(snoozed, NOW)).toBe("snoozed");
    // Snooze expired → visible again
    const expired = { ...snoozed, dutySnoozeUntil: days(1).toISOString() };
    expect(dutyCardCollapsed(expired, NOW)).toBe("no");
    // Capped → permanent chip regardless of until
    expect(dutyCardCollapsed({ dutySnoozeCount: DUTY_SNOOZE_CAP }, NOW)).toBe("capped");
  });
});
