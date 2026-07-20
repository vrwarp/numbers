/**
 * Failure bookkeeping for one annotation-job attempt, kept pure for unit
 * testing. Quota/rate-limit rejections are transient and provider-wide: they
 * re-queue after the configured cooldown WITHOUT burning an attempt (a
 * quota-crushed deployment should keep dripping forever, that is the point of
 * the pace). Real errors burn attempts with exponential backoff until the job
 * fails terminally.
 */

/** Attempts after which a non-quota failure becomes terminal. */
export const ANNOTATION_MAX_ATTEMPTS = 5;

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 3_600_000;

export type AnnotationRetryPlan =
  | { kind: "requeue"; attempts: number; nextAttemptAt: Date }
  | { kind: "failed"; attempts: number };

export function annotationRetryPlan(input: {
  /** Job attempts recorded BEFORE this failure. */
  attempts: number;
  isQuota: boolean;
  quotaCooldownMs: number;
  now: number;
}): AnnotationRetryPlan {
  if (input.isQuota) {
    return {
      kind: "requeue",
      attempts: input.attempts,
      nextAttemptAt: new Date(input.now + Math.max(input.quotaCooldownMs, 1_000)),
    };
  }
  const attempts = input.attempts + 1;
  if (attempts >= ANNOTATION_MAX_ATTEMPTS) return { kind: "failed", attempts };
  const backoff = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
  return { kind: "requeue", attempts, nextAttemptAt: new Date(input.now + backoff) };
}

/** Milliseconds the worker must still wait before its next provider call
 *  (the ≤1-receipt-per-PACE drip). 0 = clear to call now. */
export function paceWaitMs(lastCallAt: number, now: number, paceMs: number): number {
  if (paceMs <= 0 || lastCallAt <= 0) return 0;
  return Math.max(0, lastCallAt + paceMs - now);
}
