import { describe, expect, it, vi } from "vitest";
import {
  RESTART_BACKOFF_CAP_MS,
  restartDelayMs,
  superviseWorkerLoop,
} from "@/lib/worker-supervisor";

/** No real timers: the supervisor's sleep is injected. */
const instant = () => Promise.resolve();

describe("restartDelayMs", () => {
  it("backs off exponentially and caps", () => {
    expect(restartDelayMs(0)).toBe(1000);
    expect(restartDelayMs(1)).toBe(2000);
    expect(restartDelayMs(2)).toBe(4000);
    expect(restartDelayMs(4)).toBe(16_000);
    expect(restartDelayMs(5)).toBe(RESTART_BACKOFF_CAP_MS); // 32s would exceed the cap
    expect(restartDelayMs(50)).toBe(RESTART_BACKOFF_CAP_MS);
    // Never grows past the cap however long the outage lasts.
    expect(restartDelayMs(1_000_000)).toBe(RESTART_BACKOFF_CAP_MS);
  });
});

describe("superviseWorkerLoop", () => {
  it("restarts a loop that throws, and never rejects (a worker fault can't kill the server)", async () => {
    let stopped = false;
    let starts = 0;
    const errors: string[] = [];

    const done = superviseWorkerLoop(
      "test worker",
      () => stopped,
      async () => {
        starts++;
        if (starts >= 3) {
          stopped = true; // third run "stops" cleanly
          return;
        }
        throw new Error(`boom ${starts}`);
      },
      { sleep: instant, onError: (m) => errors.push(m) }
    );

    // The returned promise resolves — it must never reject, whatever the loop does.
    await expect(done).resolves.toBeUndefined();
    expect(starts).toBe(3);
    expect(errors).toEqual([
      "[test worker] crashed; restarting",
      "[test worker] crashed; restarting",
    ]);
  });

  it("restarts a loop that returns early — a silently dead worker is the bug it prevents", async () => {
    let stopped = false;
    let starts = 0;
    const errors: string[] = [];

    await superviseWorkerLoop(
      "quitter",
      () => stopped,
      async () => {
        starts++;
        if (starts === 2) stopped = true;
        // Returns without stopping the first time: the loop ended on its own.
      },
      { sleep: instant, onError: (m) => errors.push(m) }
    );

    expect(starts).toBe(2);
    expect(errors).toEqual(["[quitter] loop exited unexpectedly; restarting"]);
  });

  it("does not restart after stop(), and logs nothing on a clean shutdown", async () => {
    let stopped = false;
    let starts = 0;
    const errors: string[] = [];

    await superviseWorkerLoop(
      "clean",
      () => stopped,
      async () => {
        starts++;
        stopped = true; // the owner called stop() while we ran
      },
      { sleep: instant, onError: (m) => errors.push(m) }
    );

    expect(starts).toBe(1);
    expect(errors).toEqual([]);
  });

  it("never starts a loop that is already stopped", async () => {
    const loop = vi.fn(async () => {});
    await superviseWorkerLoop("pre-stopped", () => true, loop, { sleep: instant });
    expect(loop).not.toHaveBeenCalled();
  });

  it("passes the thrown error through to the logger for diagnosis", async () => {
    let stopped = false;
    const seen: unknown[] = [];
    await superviseWorkerLoop(
      "detail",
      () => stopped,
      async () => {
        stopped = true;
        throw new Error("db offline");
      },
      { sleep: instant, onError: (_m, err) => seen.push(err) }
    );
    expect((seen[0] as Error).message).toBe("db offline");
  });

  it("waits the backoff between restarts", async () => {
    let stopped = false;
    let starts = 0;
    const slept: number[] = [];
    await superviseWorkerLoop(
      "backoff",
      () => stopped,
      async () => {
        starts++;
        if (starts === 3) stopped = true;
        throw new Error("fail");
      },
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
        onError: () => {},
      }
    );
    expect(slept).toEqual([1000, 2000]);
  });
});
