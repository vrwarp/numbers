import path from "path";

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
  return process.env.AI_MOCK === "1";
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
  const raw = process.env[name];
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
  return process.env.AUTH_TEST_MODE === "1";
}
