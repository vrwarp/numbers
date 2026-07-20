/**
 * E-sign setup-nudge state (docs/ESIGN_SETUP_DISCOVERABILITY.md): the shape of
 * `User.esignNudgesJson` and the pure merge rule the PATCH route applies.
 *
 * Dependency-free and isomorphic (client sends deltas, server merges) with the
 * same unit-test discipline as the other pure e-sign modules. The design
 * constraint that matters: a member's decline is a CONSENT record — it must
 * survive multi-tab races, parse failures, and forward-compat churn, so every
 * mark is monotonic (set-only; nothing in this file ever unsets a key) and the
 * merge preserves keys it doesn't recognize.
 */

export interface EsignNudgeState {
  /** Terminal decline of the member invite ("I'll stick with paper"). Only a
   *  real state change (enrolling anyway; entering the duty cohort) outranks
   *  it — and those live in the render predicate, never as a key deletion. */
  declined?: true;
  /** First render of the member home card (ISO) — the 21-day decay anchor. */
  firstSeenMember?: string;
  /** Duty-card snoozes ("Remind me next week"): count is capped by the
   *  predicate (4 → permanent chip); until is the next allowed show (ISO). */
  dutySnoozeCount?: number;
  dutySnoozeUntil?: string;
  /** One-shot marks, set only by explicit client action. */
  paperRepeatShown?: true;
  closureShown?: true;
  /** Forward compat: unknown keys from newer builds are preserved verbatim. */
  [key: string]: unknown;
}

/** The home-slot decision computed server-side (nudge-server.ts) and rendered
 *  by the client island — lives here so client code imports only this
 *  dependency-free module, never the prisma-touching server helper. */
export type SetupState = "none" | "pending";

export interface HomeNudgeDecision {
  variant: "member" | "duty" | "closure";
  state: SetupState;
  /** Decayed/snoozed-out cards render as a one-line chip instead of vanishing. */
  collapsed: boolean;
  /** Member card only: the bounded once-ever re-ask after a paper-exit claim. */
  paperRepeat: boolean;
  /** Closure card: the parked claim to point at (recomputed per render; null =
   *  claim-less closure copy). */
  closureClaim: { id: string; totalCents: number; createdAt: string } | null;
}

/** Client → server delta: every field is an intent, not a value — the server
 *  computes timestamps/counters so two tabs converge instead of racing. */
export interface EsignNudgePatch {
  declined?: boolean;
  firstSeenMember?: boolean;
  dutySnooze?: boolean;
  paperRepeatShown?: boolean;
  closureShown?: boolean;
}

/** Parse a stored esignNudgesJson column. A corrupt value degrades to {} —
 *  losing marks re-invites at worst; inventing marks could silence a nudge the
 *  user never saw, so never guess. */
export function parseNudgeState(json: string | null | undefined): EsignNudgeState {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as EsignNudgeState)
      : {};
  } catch {
    return {};
  }
}

export const DUTY_SNOOZE_DAYS = 7;
export const DUTY_SNOOZE_CAP = 4;
export const MEMBER_DECAY_DAYS = 21;
export const PENDING_STALE_DAYS = 14;
export const PAPER_REPEAT_MIN_AGE_DAYS = 14;

/**
 * Apply a delta to a stored state. Monotonic: booleans only ever become true,
 * the snooze counter only grows, firstSeen keeps its earliest value — so
 * replaying a stale tab's PATCH can never resurrect a dismissed/declined
 * state (last-write-wins is exactly the bug this shape exists to prevent).
 */
export function mergeNudgeState(
  stored: EsignNudgeState,
  patch: EsignNudgePatch,
  now: Date
): EsignNudgeState {
  const next: EsignNudgeState = { ...stored };
  if (patch.declined) next.declined = true;
  if (patch.paperRepeatShown) next.paperRepeatShown = true;
  if (patch.closureShown) next.closureShown = true;
  if (patch.firstSeenMember && !next.firstSeenMember) {
    next.firstSeenMember = now.toISOString();
  }
  if (patch.dutySnooze) {
    next.dutySnoozeCount = Math.min((next.dutySnoozeCount ?? 0) + 1, DUTY_SNOOZE_CAP);
    next.dutySnoozeUntil = new Date(
      now.getTime() + DUTY_SNOOZE_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
  }
  return next;
}

function olderThanDays(iso: string | undefined, days: number, now: Date): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && now.getTime() - t > days * 24 * 60 * 60 * 1000;
}

/** Member card decay: full card until 21 days after first seen, chip after. */
export function memberCardCollapsed(state: EsignNudgeState, now: Date): boolean {
  return olderThanDays(state.firstSeenMember, MEMBER_DECAY_DAYS, now);
}

/** Pending staleness: after two weeks un-vouched the cheer collapses too —
 *  escalation belongs to the human channel, never a louder card. */
export function pendingStale(identityCreatedAt: Date | null | undefined, now: Date): boolean {
  return (
    !!identityCreatedAt &&
    now.getTime() - identityCreatedAt.getTime() > PENDING_STALE_DAYS * 24 * 60 * 60 * 1000
  );
}

/** Duty card visibility for the current snooze state. */
export function dutyCardCollapsed(state: EsignNudgeState, now: Date): "no" | "snoozed" | "capped" {
  if ((state.dutySnoozeCount ?? 0) >= DUTY_SNOOZE_CAP) return "capped";
  if (state.dutySnoozeUntil && !olderThanDays(state.dutySnoozeUntil, 0, now)) {
    const t = Date.parse(state.dutySnoozeUntil);
    if (Number.isFinite(t) && t > now.getTime()) return "snoozed";
  }
  return "no";
}
