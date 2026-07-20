import type { NotificationKind } from "./catalog";
import { KIND_SPECS } from "./catalog";

/**
 * Send-time preference/duty policy (docs/NOTIFICATIONS_DESIGN.md §7.3) as
 * pure functions, so the unit suite drives them without a database.
 */

export const CATEGORY_COLUMN: Record<
  string,
  "notifySigning" | "notifyClaimProgress" | "notifyFinance" | "notifySecurity"
> = {
  signing: "notifySigning",
  claims: "notifyClaimProgress",
  finance: "notifyFinance",
  security: "notifySecurity",
};

export type PushRecipient = {
  role: string;
  notifyEnabled: boolean;
  notifySigning: boolean;
  notifyClaimProgress: boolean;
  notifyFinance: boolean;
  notifySecurity: boolean;
  financePaused: boolean;
};

/** Preferences are consulted ONLY here — enqueue is unconditional (§5/§7.1).
 *  Finance re-checks the duty too: role/pause may have changed since enqueue. */
export function recipientWantsPush(user: PushRecipient, kind: NotificationKind): boolean {
  if (!user.notifyEnabled) return false;
  const category = KIND_SPECS[kind].category;
  if (category === "") return true; // self-test: master switch only
  if (!user[CATEGORY_COLUMN[category]]) return false;
  if (category === "finance") {
    return ["treasurer", "admin"].includes(user.role) && !user.financePaused;
  }
  return true;
}

/** Retry backoff: 30s · 2^attempt. */
export function backoffMs(attempts: number): number {
  return 30_000 * 2 ** attempts;
}
