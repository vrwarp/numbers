/**
 * Push-notification catalog (docs/NOTIFICATIONS_DESIGN.md §5): the canonical
 * kind/category vocabulary shared by the enqueue helpers, the worker, and the
 * client activity list. CLIENT-SAFE — no server imports.
 */

export const NOTIFICATION_KINDS = [
  "signing-request",
  "claim-approved",
  "claim-rejected",
  "finance-queue",
  "claim-paid",
  "device-request",
  "self-test",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Canonical preference-category keys (§8.2). "" = master switch only. */
export type NotificationCategory = "signing" | "claims" | "finance" | "security" | "";

/** Event params frozen into NotificationJob.payloadJson at enqueue. Localized
 *  text is composed FROM these at send time (push) or render time (activity
 *  list) — never stored (§6). */
export type NotificationParams = {
  /** When the event actually happened (ISO) — the §7.3 age gate keys off this,
   *  not the row's createdAt (reconcile-sourced events are late). */
  occurredAt: string;
  /** Claim event label (claimEvent only — NEVER claimDescription, §9.1). */
  label?: string;
  /** Actor's display name (e.g. the submitter on signing-request). */
  name?: string;
  /** device-request only: the requesting device's PushToken.id, excluded from
   *  recipients (§7.1b — a row id, never the token credential itself). */
  excludeTokenId?: string;
};

type KindSpec = {
  category: NotificationCategory;
  /** Web-push TTL seconds; also the §7.3 event-age gate horizon. */
  ttlSeconds: number;
  /** Tray tag (collapse key) — readable form; the wire Topic is a hash of it. */
  tag: (recipientId: string, targetId: string) => string;
  /** Click-through route (must stay within CLICK_ROUTE_PREFIXES). */
  route: (targetId: string) => string;
  /** Whether the discreet-previews toggle rewrites this kind's text (§8.2 —
   *  claim-lifecycle only; security/self-test carry no personal data). */
  discreetable: boolean;
};

const DAY = 24 * 60 * 60;

export const KIND_SPECS: Record<NotificationKind, KindSpec> = {
  "signing-request": {
    category: "signing",
    ttlSeconds: 14 * DAY,
    tag: (_r, targetId) => `signing:${targetId}`,
    route: (targetId) => `/approvals?open=${targetId}`,
    discreetable: true,
  },
  "claim-approved": {
    category: "claims",
    ttlSeconds: 7 * DAY,
    tag: (_r, targetId) => `claim:${targetId}`,
    route: (targetId) => `/claims/${targetId}`,
    discreetable: true,
  },
  "claim-rejected": {
    category: "claims",
    ttlSeconds: 14 * DAY,
    tag: (_r, targetId) => `claim:${targetId}`,
    route: (targetId) => `/claims/${targetId}`,
    discreetable: true,
  },
  // Coalesced per recipient (§5): tray tag keys on the RECIPIENT so a second
  // approved claim replaces the first ("2 claims are ready for payment").
  "finance-queue": {
    category: "finance",
    ttlSeconds: 7 * DAY,
    tag: (recipientId) => `finance:${recipientId}`,
    route: () => "/finance",
    discreetable: true,
  },
  "claim-paid": {
    category: "claims",
    ttlSeconds: 3 * DAY,
    tag: (_r, targetId) => `claim:${targetId}`,
    route: (targetId) => `/claims/${targetId}`,
    discreetable: true,
  },
  "device-request": {
    category: "security",
    ttlSeconds: 30 * 60,
    tag: (recipientId) => `device:${recipientId}`,
    route: () => "/",
    discreetable: false,
  },
  "self-test": {
    category: "", // master switch only; bypasses categories AND the quiet window (§5)
    ttlSeconds: 10 * 60,
    tag: (recipientId) => `selftest:${recipientId}`,
    route: () => "/profile",
    discreetable: false,
  },
};

/** Kinds exempt from the (dormant) quiet window: genuine urgency / diagnostic. */
export const QUIET_EXEMPT_KINDS: ReadonlySet<NotificationKind> = new Set([
  "device-request",
  "self-test",
]);

/** §7.5: the click handler accepts only same-origin paths under these
 *  prefixes — a forged payload must not deep-link elsewhere. */
export const CLICK_ROUTE_PREFIXES = ["/approvals", "/finance", "/claims/", "/profile", "/"] as const;

export function isAllowedClickRoute(route: string): boolean {
  if (!route.startsWith("/") || route.startsWith("//")) return false;
  if (route === "/") return true;
  return CLICK_ROUTE_PREFIXES.some((p) => {
    if (p === "/") return false; // exact-match only — never a match-everything prefix
    if (p.endsWith("/")) return route.startsWith(p) && route.length > p.length;
    return route === p || route.startsWith(`${p}?`) || route.startsWith(`${p}#`);
  });
}

export function isNotificationKind(kind: string): kind is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(kind);
}

/** §7.3 age gate: an event older than its kind's TTL must never fire —
 *  FCM's TTL bounds time in FCM's queue, not time in ours. */
export function eventExpired(kind: NotificationKind, occurredAt: string, nowMs: number): boolean {
  const t = Date.parse(occurredAt);
  if (Number.isNaN(t)) return true; // malformed timestamp → fail closed
  return nowMs - t > KIND_SPECS[kind].ttlSeconds * 1000;
}
