/**
 * Supervision for the three background worker loops (annotation, embedding,
 * notification outbox). All three are long-lived `async` loops started from
 * `src/instrumentation.ts` and then never awaited by anyone — which, bare,
 * gives them two production failure modes:
 *
 *  1. **A rejection that escapes the loop's own try/catch kills the server.**
 *     Each loop wraps its work in try/catch, but the surrounding plumbing —
 *     the boot delay, and the `await sleep(pollMs())` whose argument is
 *     evaluated OUTSIDE the try — is not covered. Node's default
 *     `--unhandled-rejections=throw` turns any such throw into process exit,
 *     so a transient fault in a *secondary* subsystem (search indexing, push)
 *     would take down receipt capture and claim review with it.
 *
 *  2. **A loop that ends is silently dead forever.** Nothing observes the
 *     IIFE's promise, so a loop that returns (or throws) just stops draining
 *     its queue with no log, no restart, and no symptom until someone notices
 *     receipts are never read.
 *
 * `superviseWorkerLoop` closes both: every escape is caught and logged, and
 * the loop is restarted with capped exponential backoff until its owner asks
 * it to stop. Restarts are safe because all three loops are idempotent by
 * construction — jobs are claimed with leases and finalized conditionally on
 * their generation, so a restarted loop re-claims rather than double-writes.
 */

/** Backoff between restarts: 1s, 2s, 4s … capped, so a persistently failing
 *  loop can't spin the CPU while still recovering promptly from a one-off. */
export const RESTART_BACKOFF_CAP_MS = 30_000;

export function restartDelayMs(consecutiveRestarts: number): number {
  return Math.min(RESTART_BACKOFF_CAP_MS, 1000 * 2 ** Math.min(consecutiveRestarts, 5));
}

export interface SuperviseOptions {
  /** Injected in tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; defaults to console.error. */
  onError?: (message: string, err?: unknown) => void;
}

/**
 * Run `loop` forever under supervision. Returns a promise that settles when
 * the loop is stopped — nothing needs to await it (the supervisor itself can
 * never reject), but tests do.
 *
 * @param name    log label, e.g. "annotation worker"
 * @param stopped read the owner's stop flag — checked before every restart
 * @param loop    the worker's own loop; may return (done) or throw (crashed)
 */
export function superviseWorkerLoop(
  name: string,
  stopped: () => boolean,
  loop: () => Promise<void>,
  opts: SuperviseOptions = {}
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const onError = opts.onError ?? ((message: string, err?: unknown) => console.error(message, err));

  return (async () => {
    let restarts = 0;
    while (!stopped()) {
      try {
        await loop();
        // A clean return is only expected when the owner called stop().
        if (stopped()) return;
        onError(`[${name}] loop exited unexpectedly; restarting`);
      } catch (err) {
        onError(`[${name}] crashed; restarting`, err);
      }
      if (stopped()) return;
      await sleep(restartDelayMs(restarts));
      restarts++;
    }
  })().catch((err) => {
    // Unreachable in practice (the loop body above catches everything) — but
    // this is the last line between a worker fault and a dead server, so it
    // is deliberately belt-and-suspenders.
    onError(`[${name}] supervisor failed`, err);
  });
}
