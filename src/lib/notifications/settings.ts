import { configValue } from "@/lib/config-file";
import { firebaseWebConfig } from "@/lib/firebase-admin";
import type { NotificationKind } from "./catalog";
import { QUIET_EXEMPT_KINDS } from "./catalog";

/**
 * Push runtime configuration (docs/NOTIFICATIONS_DESIGN.md §7/§12/§13).
 * SERVER ONLY. All values are hot-read per call (env or <DATA_DIR>/config.json),
 * matching the AI/embedding knobs.
 */

/** PUSH_MOCK=1: the send adapter records deliveries locally instead of FCM,
 *  and the client registers synthetic tokens (the AI_MOCK/AUTH_TEST_MODE
 *  convention) — full queue/preference behavior, zero network. */
export function isPushMock(): boolean {
  return configValue("PUSH_MOCK") === "1";
}

/** The messaging-only service-account JSON (§4). Never exposed by any GET. */
export function pushServiceAccountJson(): string | undefined {
  const raw = configValue("FCM_SERVICE_ACCOUNT_JSON");
  return raw && raw.trim() ? raw : undefined;
}

/** Client-safe VAPID public key (Firebase console → Web Push certificates). */
export function pushVapidKey(): string | undefined {
  const raw = configValue("FIREBASE_VAPID_PUBLIC_KEY");
  return raw && raw.trim() ? raw : undefined;
}

/** Push is configured when we can actually send: mock, or SA + VAPID key
 *  (+ the client needs messagingSenderId/appId — checked client-side where
 *  the web config is assembled). */
export function isPushConfigured(): boolean {
  return isPushMock() || (!!pushServiceAccountJson() && !!pushVapidKey());
}

/** Fingerprint of the SA for the §12 admin card — never the key. */
export function pushServiceAccountFingerprint(): string | null {
  const raw = pushServiceAccountJson();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { client_email?: string; project_id?: string };
    return parsed.client_email ?? parsed.project_id ?? "configured";
  } catch {
    return "configured (unparseable)";
  }
}

export type ScopeCheck = "ok" | "broad" | "unknown" | "mock" | "unconfigured";

/**
 * §12 SA scope self-check (a testIamPermissions probe): the predictable
 * failure of the console walkthrough is a frustrated volunteer granting
 * "Firebase Admin", which would silently void the keyless-ledger property.
 * "broad" = the account can also touch Firestore. Accepts an explicit JSON
 * (the setup wizard's draft) or falls back to the stored credential.
 */
export async function serviceAccountScopeCheck(rawJson?: string): Promise<ScopeCheck> {
  if (isPushMock()) return "mock";
  const raw = rawJson?.trim() || pushServiceAccountJson();
  if (!raw) return "unconfigured";
  try {
    const projectId = (JSON.parse(raw) as { project_id?: string }).project_id;
    if (!projectId) return "unknown";
    const { getApps, initializeApp, cert } = await import("firebase-admin/app");
    // A distinct app name per credential so a draft test never collides with
    // the live "push" send app.
    const appName = rawJson ? "push-probe" : "push";
    const app =
      getApps().find((a) => a.name === appName) ??
      initializeApp({ credential: cert(JSON.parse(raw)) }, appName);
    const token = await app.options.credential?.getAccessToken();
    if (!token) return "unknown";
    const res = await fetch(
      `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:testIamPermissions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          permissions: ["cloudmessaging.messages.create", "datastore.entities.get"],
        }),
      }
    );
    if (!res.ok) return "unknown";
    const body = (await res.json()) as { permissions?: string[] };
    const granted = new Set(body.permissions ?? []);
    if (granted.has("datastore.entities.get")) return "broad";
    return granted.has("cloudmessaging.messages.create") ? "ok" : "unknown";
  } catch {
    return "unknown";
  }
}

/** §12 deployment-level pause: enqueues continue (activity list stays whole);
 *  the worker just stops sending until unpaused. Admin-writable via
 *  config.json (NOTIFY_PAUSED). */
export function isPushPaused(): boolean {
  return configValue("NOTIFY_PAUSED") === "1";
}

/** What the client needs to run the §7.7/§8.3 flows. Client-safe values only
 *  (the firebase block is the same one the sign-in page already relays). */
export function pushWebConfig(): {
  configured: boolean;
  mock: boolean;
  vapidKey?: string;
  firebase: ReturnType<typeof firebaseWebConfig>;
} {
  const firebase = firebaseWebConfig();
  const mock = isPushMock();
  const real =
    !!pushServiceAccountJson() && !!pushVapidKey() && !!firebase && !!firebase.messagingSenderId;
  return {
    configured: mock || real,
    mock,
    vapidKey: pushVapidKey(),
    firebase,
  };
}

/**
 * Quiet window (§7.3) — built dormant, DEFAULT OFF (§15 #2: pews are silent
 * by habit, finance batches after lunch, device DND is the personal
 * instrument). NOTIFY_QUIET, when set, holds claim-lifecycle sends:
 *   "21:30-08:00"                  overnight window (may wrap midnight)
 *   "21:30-08:00,sun:09:00-12:30"  plus a Sunday block
 * Times are server-local (one congregation = one deployment = one timezone).
 */
type Window = { startMin: number; endMin: number; dow?: number };

function parseHhMm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function parseQuietWindows(spec: string): Window[] {
  const out: Window[] = [];
  for (const part of spec.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const dowMatch = /^([a-z]{3}):(.*)$/i.exec(p);
    const dow = dowMatch ? DOW[dowMatch[1].toLowerCase()] : undefined;
    const range = dowMatch ? dowMatch[2] : p;
    const [a, b] = range.split("-");
    const startMin = a !== undefined ? parseHhMm(a) : null;
    const endMin = b !== undefined ? parseHhMm(b) : null;
    if (startMin === null || endMin === null) continue; // malformed → ignore that part
    if (dowMatch && dow === undefined) continue;
    out.push({ startMin, endMin, dow });
  }
  return out;
}

/** Milliseconds until `now` leaves every active quiet window (0 = not quiet).
 *  Pure so the unit suite can drive it with fixed dates. */
export function quietHoldMs(windows: Window[], now: Date): number {
  let hold = 0;
  for (const w of windows) {
    const minutes = now.getHours() * 60 + now.getMinutes();
    const inDow = (d: number) => (w.dow === undefined ? true : w.dow === d);
    let msUntilEnd = 0;
    if (w.startMin <= w.endMin) {
      // Same-day window.
      if (inDow(now.getDay()) && minutes >= w.startMin && minutes < w.endMin) {
        msUntilEnd = (w.endMin - minutes) * 60_000 - now.getSeconds() * 1000;
      }
    } else {
      // Wraps midnight: [start,24h) belongs to the window's day, [0,end) to the next.
      if (inDow(now.getDay()) && minutes >= w.startMin) {
        msUntilEnd = (24 * 60 - minutes + w.endMin) * 60_000 - now.getSeconds() * 1000;
      } else if (inDow((now.getDay() + 6) % 7) && minutes < w.endMin) {
        msUntilEnd = (w.endMin - minutes) * 60_000 - now.getSeconds() * 1000;
      }
    }
    hold = Math.max(hold, msUntilEnd);
  }
  return hold;
}

/** Hold time for a kind right now (0 = send). Includes a small jitter so the
 *  window's edge doesn't fire every held job in one thundering buzz (§7.3). */
export function quietHoldForKind(kind: NotificationKind, now = new Date()): number {
  if (QUIET_EXEMPT_KINDS.has(kind)) return 0;
  const spec = configValue("NOTIFY_QUIET");
  if (!spec || !spec.trim()) return 0; // default OFF (§15 #2)
  const hold = quietHoldMs(parseQuietWindows(spec), now);
  if (hold <= 0) return 0;
  return hold + Math.floor(Math.random() * 5 * 60_000);
}
