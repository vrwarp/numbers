/**
 * Client-side rate limiting and quota-error retry for provider calls.
 *
 * Gemini's free tier allows ~15 requests/minute. Two mechanisms keep us under
 * whatever quota the deployment has:
 *   - RateLimiter paces outgoing calls to AI_RPM_TARGET requests per minute so
 *     we mostly never trip the quota in the first place.
 *   - withQuotaRetry is the safety net: when the provider still answers with a
 *     quota/rate-limit error (429), it waits out the cooldown and retries,
 *     notifying the caller each time it waits.
 */

import { rpmTarget } from "@/lib/config";
import { ProviderCallError } from "./providers";

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A rolling-window limiter: at most `rpm` grants in any `windowMs` span. Grants
 * are serialized so concurrent callers can't race past the window; the first
 * `rpm` go through immediately (bursty, so small claims stay fast) and further
 * grants wait until the oldest one ages out. `now`/`sleep` are injectable for
 * deterministic tests.
 */
export class RateLimiter {
  private readonly history: number[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly rpm: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep
  ) {}

  /** Resolves when the caller is cleared to make one request. */
  acquire(): Promise<void> {
    const gated = this.tail.then(() => this.reserve());
    // Keep the chain alive regardless of how this reservation settles.
    this.tail = gated.then(
      () => undefined,
      () => undefined
    );
    return gated;
  }

  private async reserve(): Promise<void> {
    if (this.rpm <= 0) return; // unlimited
    this.prune();
    if (this.history.length >= this.rpm) {
      const waitMs = this.history[0] + this.windowMs - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      this.prune();
    }
    this.history.push(this.now());
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.history.length > 0 && this.history[0] <= cutoff) this.history.shift();
  }
}

// Process-wide limiter so the RPM cap holds across concurrent claim
// generations, not just within one request. Built lazily from AI_RPM_TARGET
// and rebuilt when that target changes, so an admin editing config.json at
// runtime (the documented hot-reload) actually re-paces — the previous cached
// limiter kept the old rate until process restart.
let sharedLimiter: RateLimiter | null = null;
let sharedLimiterRpm: number | null = null;

function getRateLimiter(): RateLimiter {
  const rpm = rpmTarget();
  if (!sharedLimiter || sharedLimiterRpm !== rpm) {
    sharedLimiter = new RateLimiter(rpm);
    sharedLimiterRpm = rpm;
  }
  return sharedLimiter;
}

/** Wait for a slot in the process-wide RPM budget before calling the provider. */
export function acquireRateSlot(): Promise<void> {
  return getRateLimiter().acquire();
}

/** Test hook: drop the shared limiter so the next acquire re-reads AI_RPM_TARGET. */
export function resetRateLimiterForTests(): void {
  sharedLimiter = null;
  sharedLimiterRpm = null;
}

const QUOTA_RE = /\b429\b|quota|rate[ -]?limit|resource_exhausted|too many requests/i;

/** True when a message/body reads like a quota or rate-limit rejection. */
export function isQuotaErrorMessage(text: string | null | undefined): boolean {
  return typeof text === "string" && QUOTA_RE.test(text);
}

/** True when an error is a provider quota/rate-limit rejection (HTTP 429 or quota text). */
export function isQuotaError(err: unknown): boolean {
  if (err instanceof ProviderCallError) {
    return (
      err.status === 429 ||
      isQuotaErrorMessage(err.message) ||
      isQuotaErrorMessage(err.rawResponse)
    );
  }
  return false;
}

export interface QuotaWaitInfo {
  attempt: number;
  maxRetries: number;
  cooldownMs: number;
  error: string;
}

export interface QuotaRetryOptions {
  maxRetries: number;
  cooldownMs: number;
  /** Called just before each cooldown wait, so the caller can notify the user. */
  onWait?: (info: QuotaWaitInfo) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `fn`, and on a quota error wait `cooldownMs` and retry, up to `maxRetries`
 * times. Non-quota errors propagate immediately. `onWait` fires before each
 * wait (attempt is 1-based) so the wait can be surfaced to the user.
 */
export async function withQuotaRetry<T>(
  fn: () => Promise<T>,
  opts: QuotaRetryOptions
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isQuotaError(err) || attempt >= opts.maxRetries) throw err;
      attempt += 1;
      opts.onWait?.({
        attempt,
        maxRetries: opts.maxRetries,
        cooldownMs: opts.cooldownMs,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(opts.cooldownMs);
    }
  }
}
