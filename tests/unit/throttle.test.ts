import { describe, expect, it, vi } from "vitest";
import {
  RateLimiter,
  isQuotaError,
  isQuotaErrorMessage,
  withQuotaRetry,
} from "@/lib/ai/throttle";
import { ProviderCallError } from "@/lib/ai/providers";

describe("RateLimiter", () => {
  it("lets the first rpm calls through, then paces by the window", async () => {
    let clock = 0;
    let slept = 0;
    const rl = new RateLimiter(
      3,
      1000,
      () => clock,
      async (ms) => {
        slept += ms;
        clock += ms;
      }
    );

    for (let i = 0; i < 3; i++) await rl.acquire();
    expect(slept).toBe(0); // burst of rpm is immediate

    await rl.acquire(); // 4th must wait for the oldest to age out of the window
    expect(slept).toBe(1000);
    expect(clock).toBe(1000);
  });

  it("serializes concurrent acquires so the cap holds under parallelism", async () => {
    let clock = 0;
    let slept = 0;
    const rl = new RateLimiter(
      2,
      1000,
      () => clock,
      async (ms) => {
        slept += ms;
        clock += ms;
      }
    );

    // Fire five at once; only two fit per window, so three must wait.
    await Promise.all(Array.from({ length: 5 }, () => rl.acquire()));
    expect(slept).toBeGreaterThanOrEqual(1000);
  });

  it("treats rpm <= 0 as unlimited (never waits)", async () => {
    let slept = 0;
    const rl = new RateLimiter(0, 1000, () => 0, async (ms) => {
      slept += ms;
    });
    for (let i = 0; i < 50; i++) await rl.acquire();
    expect(slept).toBe(0);
  });
});

describe("quota detection", () => {
  it("flags 429 and quota-ish text, ignores unrelated errors", () => {
    expect(isQuotaError(new ProviderCallError("boom", null, 429))).toBe(true);
    expect(isQuotaError(new ProviderCallError("quota exceeded", null, 400))).toBe(true);
    expect(isQuotaError(new ProviderCallError("bad request", "invalid", 400))).toBe(false);
    expect(isQuotaError(new Error("429"))).toBe(false); // not a ProviderCallError
  });

  it("isQuotaErrorMessage matches rate-limit wording", () => {
    expect(isQuotaErrorMessage("Error 429: too many requests")).toBe(true);
    expect(isQuotaErrorMessage("RESOURCE_EXHAUSTED")).toBe(true);
    expect(isQuotaErrorMessage("rate-limit hit")).toBe(true);
    expect(isQuotaErrorMessage("something else")).toBe(false);
    expect(isQuotaErrorMessage(null)).toBe(false);
  });
});

describe("withQuotaRetry", () => {
  const quota = new ProviderCallError("Google API error 429: quota", "quota exceeded", 429);

  it("retries a quota error then succeeds, notifying on each wait", async () => {
    let calls = 0;
    const onWait = vi.fn();
    const out = await withQuotaRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw quota;
        return "ok";
      },
      { maxRetries: 2, cooldownMs: 5, onWait, sleep: async () => {} }
    );
    expect(out).toBe("ok");
    expect(calls).toBe(2);
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(onWait.mock.calls[0][0]).toMatchObject({ attempt: 1, maxRetries: 2, cooldownMs: 5 });
  });

  it("gives up after maxRetries and rethrows the quota error", async () => {
    let calls = 0;
    const onWait = vi.fn();
    await expect(
      withQuotaRetry(
        async () => {
          calls += 1;
          throw quota;
        },
        { maxRetries: 1, cooldownMs: 0, onWait, sleep: async () => {} }
      )
    ).rejects.toBe(quota);
    expect(calls).toBe(2); // initial attempt + 1 retry
    expect(onWait).toHaveBeenCalledTimes(1);
  });

  it("never retries a non-quota error", async () => {
    const boom = new ProviderCallError("boom", null, 500);
    let calls = 0;
    await expect(
      withQuotaRetry(
        async () => {
          calls += 1;
          throw boom;
        },
        { maxRetries: 3, cooldownMs: 0, sleep: async () => {} }
      )
    ).rejects.toBe(boom);
    expect(calls).toBe(1);
  });
});
