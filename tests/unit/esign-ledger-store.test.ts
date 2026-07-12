// The roster live-update subscription (docs/ESIGN_DESIGN.md §4.3): the mock
// backend stands in for Firestore's onSnapshot with polling, and must (a) never
// fire for the state present at subscription time, (b) fire once when the event
// set changes (a vouch/role landing), and (c) keep polling through a transient
// failure. fetch + timers are faked; no server. The production onSnapshot path
// is exercised by the emulator e2e (tests/esign-e2e/esign.spec.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLedgerStore } from "@/lib/esign/store";

type Events = { eventId: string }[];

// Several poll cycles — resilient to the store's exact cadence: a change made at
// the start of a step fires exactly once within it (later ticks see it as seen).
const STEP_MS = 6000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("mock ledger store subscribe (roster live-update)", () => {
  it("fires onChange only after the event set changes, never on the first snapshot", async () => {
    vi.useFakeTimers();
    let events: Events = [{ eventId: "e1" }];
    vi.stubGlobal(
      "fetch",
      async () => ({ ok: true, status: 200, json: async () => ({ events }) }) as Response
    );

    const store = getLedgerStore("mock");
    const changes = vi.fn();
    const unsub = store.subscribe("roster-1", changes);

    // Baseline established + steady polls against the same events: no fire.
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(changes).not.toHaveBeenCalled();

    // A vouch lands (a new event): fires exactly once.
    events = [{ eventId: "e1" }, { eventId: "e2" }];
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(changes).toHaveBeenCalledTimes(1);

    // No further change: no further fire.
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(changes).toHaveBeenCalledTimes(1);

    // After unsubscribe the poll stops, so later changes are ignored.
    unsub();
    events = [{ eventId: "e1" }, { eventId: "e2" }, { eventId: "e3" }];
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through a transient fetch failure", async () => {
    vi.useFakeTimers();
    let fail = false;
    let events: Events = [{ eventId: "e1" }];
    vi.stubGlobal("fetch", async () => {
      if (fail) throw new Error("network blip");
      return { ok: true, status: 200, json: async () => ({ events }) } as Response;
    });

    const store = getLedgerStore("mock");
    const changes = vi.fn();
    const unsub = store.subscribe("roster-1", changes);

    await vi.advanceTimersByTimeAsync(STEP_MS); // baseline: e1
    expect(changes).not.toHaveBeenCalled();

    fail = true; // polls throw and are swallowed — the interval survives
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(changes).not.toHaveBeenCalled();

    fail = false;
    events = [{ eventId: "e1" }, { eventId: "e2" }]; // recovers, sees the change
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(changes).toHaveBeenCalledTimes(1);

    unsub();
  });
});
