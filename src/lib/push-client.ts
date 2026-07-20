"use client";

import { isEmbeddedBrowser } from "@/lib/embedded-browser";

/**
 * Client half of the §7.7 token contract + the §8.3 capability pre-flight.
 * Mock mode (relayed from PUSH_MOCK) registers a synthetic per-browser token
 * and skips FCM/permissions entirely, so suites and keyless dev exercise the
 * full server pipeline. Client-safe; firebase/messaging is imported lazily
 * so only enabling pays for the bundle.
 */

export type PushClientConfig = {
  configured: boolean;
  mock: boolean;
  vapidKey?: string;
  firebase?: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId?: string;
    messagingSenderId?: string;
  } | null;
};

/** §8.3 step 0 — never sell what this context can't deliver. */
export type PushCapability =
  | "ok" // enable flow may proceed here
  | "ios-install" // capable iPhone/iPad, but push needs the installed app (§8.4)
  | "ios-old" // iOS < 16.4: no web push, say so honestly
  | "embedded" // WeChat/Line/FB webview: open in a real browser first
  | "unsupported"; // no Push API (or insecure context)

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  // iPadOS 13+ masquerades as macOS; maxTouchPoints separates them.
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function iosMajorVersion(): number | null {
  if (typeof navigator === "undefined") return null;
  const m = /OS (\d+)_/.exec(navigator.userAgent);
  return m ? Number(m[1]) : null;
}

export function detectCapability(): PushCapability {
  if (typeof window === "undefined") return "unsupported";
  if (isEmbeddedBrowser()) return "embedded";
  if (!window.isSecureContext) return "unsupported";
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) {
    return "ok";
  }
  if (isIos()) {
    const version = iosMajorVersion();
    if (version !== null && version < 16) return "ios-old";
    // Capable hardware, but push exists only inside the installed app.
    return isStandalone() ? "unsupported" : "ios-install";
  }
  return "unsupported";
}

const MOCK_TOKEN_KEY = "numbers_mock_push_token";
/** This installation's registered token, mirrored to storage so SIGN-OUT can
 *  sever the device without loading the FCM SDK (§8.6). Same-origin readable
 *  like the token itself is via getToken — convenience, not a new exposure. */
export const LOCAL_TOKEN_KEY = "numbers.push.token";

function mockToken(): string {
  let token = localStorage.getItem(MOCK_TOKEN_KEY);
  if (!token) {
    token = `mock-${crypto.randomUUID()}`;
    localStorage.setItem(MOCK_TOKEN_KEY, token);
  }
  return token;
}

/** Short human label for the §8.6 device list — data, not translated. */
export function deviceLabel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : "Device";
  return `${browser} · ${device}${isStandalone() ? " · app" : ""}`;
}

async function fcmToken(config: PushClientConfig): Promise<string> {
  if (!config.firebase || !config.vapidKey) throw new Error("push not configured");
  const [{ initializeApp, getApps, getApp }, { getMessaging, getToken }] = await Promise.all([
    import("firebase/app"),
    import("firebase/messaging"),
  ]);
  const app = getApps().some((a) => a.name === "push")
    ? getApp("push")
    : initializeApp(config.firebase, "push");
  const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
  await navigator.serviceWorker.ready;
  return getToken(getMessaging(app), {
    vapidKey: config.vapidKey,
    serviceWorkerRegistration: registration,
  });
}

export type TokenResponse = {
  known: boolean;
  live: boolean;
  devices: { id: string; label: string; lastSeenAt: string; current: boolean }[];
};

async function postToken(
  token: string,
  register: boolean,
  label?: string
): Promise<TokenResponse | null> {
  const res = await fetch("/api/notifications/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...(register ? { register: true } : {}), ...(label ? { label } : {}) }),
  });
  if (!res.ok) return null;
  return (await res.json()) as TokenResponse;
}

export type EnableResult =
  | { ok: true; devices: TokenResponse["devices"] }
  | { ok: false; reason: "denied" | "unsupported" | "error" };

/** §8.3 step 2: called from the soft-ask's confirm gesture — the native
 *  permission prompt fires here and nowhere else. */
export async function enablePushOnThisDevice(config: PushClientConfig): Promise<EnableResult> {
  try {
    if (config.mock) {
      const token = mockToken();
      const res = await postToken(token, true, deviceLabel());
      if (res) localStorage.setItem(LOCAL_TOKEN_KEY, token);
      return res ? { ok: true, devices: res.devices } : { ok: false, reason: "error" };
    }
    if (detectCapability() !== "ok") return { ok: false, reason: "unsupported" };
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { ok: false, reason: "denied" };
    const token = await fcmToken(config);
    const res = await postToken(token, true, deviceLabel());
    if (res) localStorage.setItem(LOCAL_TOKEN_KEY, token);
    return res ? { ok: true, devices: res.devices } : { ok: false, reason: "error" };
  } catch (err) {
    console.error("push enable failed:", err);
    return { ok: false, reason: "error" };
  }
}

/** §8.6: sign-out and opt-out both sever THIS installation. Best-effort —
 *  the server row is authoritative; FCM deleteToken may fail offline. */
export async function disablePushOnThisDevice(config: PushClientConfig): Promise<void> {
  let token: string | null = null;
  if (config.mock) {
    token = localStorage.getItem(MOCK_TOKEN_KEY);
  } else if (detectCapability() === "ok" && Notification.permission === "granted") {
    token = await currentFcmToken(config).catch(() => null);
  }
  if (!token) return;
  localStorage.removeItem(LOCAL_TOKEN_KEY);
  await fetch("/api/notifications/token", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => {});
  if (!config.mock) {
    try {
      const [{ getApp }, { getMessaging, deleteToken }] = await Promise.all([
        import("firebase/app"),
        import("firebase/messaging"),
      ]);
      await deleteToken(getMessaging(getApp("push")));
    } catch {
      // Offline / never initialized: the server row is gone, which is what
      // stops delivery; the orphaned subscription reaps on next send error.
    }
  }
}

/** The current installation's token WITHOUT prompting (permission already
 *  granted). Null when this context has none. */
export async function currentFcmToken(config: PushClientConfig): Promise<string | null> {
  if (config.mock) return localStorage.getItem(MOCK_TOKEN_KEY);
  if (detectCapability() !== "ok" || Notification.permission !== "granted") return null;
  try {
    return await fcmToken(config);
  } catch {
    return null;
  }
}

/** §7.7 upsert-as-ping (app load + visibilitychange/focus): refreshes
 *  lastSeenAt + locale; the response feeds the §8.7 reconnect chip. */
export async function pingToken(config: PushClientConfig): Promise<TokenResponse | null> {
  const token = await currentFcmToken(config);
  if (!token) return null;
  return postToken(token, false);
}
