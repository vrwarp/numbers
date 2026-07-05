import path from "path";
import { configValue } from "./config-file";

export { MINISTRIES, MINISTRY_GROUPS } from "./ministries";

/** Line-item rows on one page of the official CFCC form (13-row table). */
export const FORM_ROWS_PER_PAGE = 13;

/** Target size for compressed receipt images (bytes). */
export const IMAGE_TARGET_BYTES = 100 * 1024;

/** Root directory for the SQLite db and uploaded files. */
export function dataDir(): string {
  return path.resolve(process.env.DATA_DIR || "./data");
}

export function uploadsDir(): string {
  return path.join(dataDir(), "uploads");
}

export function isAiMock(): boolean {
  return configValue("AI_MOCK") === "1";
}

/**
 * Externally-reachable origin of this deployment (PUBLIC_BASE_URL), e.g.
 * "https://numbers.example.org" — behind Docker/reverse proxies the server
 * cannot infer it, so it is explicit configuration. Used to build the
 * self-link URL stamped as a QR code on generated PDFs; when unset the PDF
 * simply omits the stamp. Trailing slashes are dropped so callers can append
 * paths directly.
 */
export function publicBaseUrl(): string | undefined {
  const raw = configValue("PUBLIC_BASE_URL")?.trim();
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "");
}

// --- AI rate limiting -------------------------------------------------------
// Gemini's free tier grants ~15 requests/minute; extraction is throttled to
// stay under whatever quota the deployment actually has. All three are read
// fresh per call so env changes (and tests) take effect without a restart.

/** Requests/minute the server paces its provider calls to (AI_RPM_TARGET). */
export const DEFAULT_RPM_TARGET = 15;
/** How long to wait out a quota/rate-limit error before retrying (AI_QUOTA_COOLDOWN_MS). */
export const DEFAULT_QUOTA_COOLDOWN_MS = 60_000;
/** Extra attempts after a quota error clears the cooldown (AI_QUOTA_MAX_RETRIES). */
export const DEFAULT_QUOTA_MAX_RETRIES = 3;

function intEnv(name: string, fallback: number, min: number): number {
  const raw = configValue(name);
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

/** Target requests/minute for AI extraction; default 15 (Gemini free tier). */
export function rpmTarget(): number {
  return intEnv("AI_RPM_TARGET", DEFAULT_RPM_TARGET, 1);
}

/** Milliseconds to pause after a quota error before retrying; default 60s. */
export function quotaCooldownMs(): number {
  return intEnv("AI_QUOTA_COOLDOWN_MS", DEFAULT_QUOTA_COOLDOWN_MS, 0);
}

/** Retries allowed after a quota error (0 = surface immediately); default 1. */
export function quotaMaxRetries(): number {
  return intEnv("AI_QUOTA_MAX_RETRIES", DEFAULT_QUOTA_MAX_RETRIES, 0);
}

export function isAuthTestMode(): boolean {
  return configValue("AUTH_TEST_MODE") === "1";
}

/**
 * When enabled, Firebase's sign-in helper (`/__/auth/*`) is served from this
 * app's own origin via a reverse proxy (see the `/fbauth` route + the
 * next.config rewrites), and the client SDK's `authDomain` is pointed at
 * `PUBLIC_BASE_URL`'s host instead of `*.firebaseapp.com`. This makes the
 * sign-in iframe/redirect first-party, so WebKit storage partitioning (iOS
 * Safari and every iOS browser, plus Firefox/Chrome) no longer breaks Google
 * sign-in with "auth/popup-blocked" or "missing initial state". Requires
 * `PUBLIC_BASE_URL` and, in the Firebase/Google console, the OAuth redirect URI
 * (`<host>/__/auth/handler`) and authorized domain registered for that host.
 */
export function isFirebaseAuthProxyEnabled(): boolean {
  return configValue("FIREBASE_AUTH_PROXY") === "1";
}

/** Bare host (`host[:port]`) of a value that may include a scheme/path. */
function hostOf(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`).host;
  } catch {
    return undefined;
  }
}

/**
 * Firebase's `authDomain` as a bare host (`host[:port]`). Firebase configs list
 * it host-only (`your-project.firebaseapp.com`), but operators routinely paste
 * a full `https://…` URL; left unnormalized that scheme would corrupt the value.
 * Only used as the client SDK's authDomain in the default (non-proxy) flow.
 */
export function firebaseAuthDomainHost(): string | undefined {
  return hostOf(configValue("FIREBASE_AUTH_DOMAIN"));
}

/**
 * Host the sign-in reverse proxy forwards to. Firebase always serves the
 * `/__/auth` helper at `<projectId>.firebaseapp.com`, so derive the upstream
 * from `FIREBASE_PROJECT_ID` rather than `FIREBASE_AUTH_DOMAIN` — once the proxy
 * is on, operators set `FIREBASE_AUTH_DOMAIN` to their OWN domain, which would
 * point the proxy back at itself (self-loop, TLS ECONNRESET). An explicit
 * `FIREBASE_AUTH_UPSTREAM_HOST` overrides for unusual projects.
 */
export function firebaseAuthUpstreamHost(): string | undefined {
  const override = hostOf(configValue("FIREBASE_AUTH_UPSTREAM_HOST"));
  if (override) return override;
  const projectId = configValue("FIREBASE_PROJECT_ID")?.trim();
  return projectId ? `${projectId}.firebaseapp.com` : undefined;
}
