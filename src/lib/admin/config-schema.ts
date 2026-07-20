/**
 * The ALLOWLIST of environment settings the admin UI may read and write
 * (docs/ADMIN.md "Guard-rails"). Nothing outside this list is exposed: the
 * bootstrap/auth-critical/test-only keys (DATABASE_URL, DATA_DIR, AUTH_SECRET,
 * AI_MOCK, AUTH_TEST_MODE, ESIGN_MOCK, CHURCH_CONTEXT_PATH, emulator hosts, …)
 * are deliberately absent so no admin can lock the deployment out through the
 * form. Dependency-free and fs-free — safe to import in client components.
 *
 * Labels/help are i18n keys under `Admin.fields.<KEY>.{label,help}`; the raw
 * env-var name is shown alongside for operators who know it.
 */

import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/timezone";

export type AdminConfigType = "text" | "number" | "boolean" | "select";

export interface AdminConfigField {
  /** The env var / config.json key. */
  key: string;
  group: "ai" | "deployment" | "esign" | "firebase";
  type: AdminConfigType;
  /** Write-only: never echoed back to the client (API returns `set` instead). */
  secret?: boolean;
  /** Options for `type: "select"` (values are the stored strings). */
  options?: string[];
  /** Boolean fields store this string when on (config is string-valued). */
  onValue?: string;
  /** Inclusive bounds for `type: "number"`. */
  min?: number;
  max?: number;
  /** Short input hint shown under the field (placeholder-style). */
  placeholder?: string;
  /** Extra validation for `type: "text"` — returns an error message, or null
   *  when the value is acceptable. Runs after trimming, never on empty. */
  validate?: (value: string) => string | null;
}

export const ADMIN_CONFIG_FIELDS: readonly AdminConfigField[] = [
  // --- AI extraction & suggestions -----------------------------------------
  { key: "AI_PROVIDER", group: "ai", type: "select", options: ["openrouter", "google"] },
  { key: "OPENROUTER_API_KEY", group: "ai", type: "text", secret: true, placeholder: "sk-or-…" },
  { key: "OPENROUTER_MODEL", group: "ai", type: "text", placeholder: "google/gemini-3.1-flash-lite" },
  { key: "GEMINI_API_KEY", group: "ai", type: "text", secret: true },
  { key: "GEMINI_MODEL", group: "ai", type: "text", placeholder: "gemini-3.1-flash-lite" },
  { key: "AI_RPM_TARGET", group: "ai", type: "number", min: 1, max: 1000 },
  { key: "AI_QUOTA_COOLDOWN_MS", group: "ai", type: "number", min: 0, max: 600000 },
  { key: "AI_QUOTA_MAX_RETRIES", group: "ai", type: "number", min: 0, max: 20 },

  // --- Deployment -----------------------------------------------------------
  { key: "PUBLIC_BASE_URL", group: "deployment", type: "text", placeholder: "https://numbers.example.org" },
  { key: "ADMIN_EMAILS", group: "deployment", type: "text", placeholder: "you@example.org, other@example.org" },
  {
    key: "TIME_ZONE",
    group: "deployment",
    type: "text",
    placeholder: DEFAULT_TIME_ZONE,
    validate: (value) =>
      isValidTimeZone(value)
        ? null
        : `TIME_ZONE must be an IANA time zone name like ${DEFAULT_TIME_ZONE}`,
  },

  // --- E-signatures ---------------------------------------------------------
  { key: "ESIGN_ROOT_EMAIL", group: "esign", type: "text", placeholder: "root@example.org" },
  { key: "ESIGN_ROOT_FINGERPRINT", group: "esign", type: "text" },
  // Persuasion-layer kill-switch (docs/ESIGN_SETUP_DISCOVERABILITY.md §2):
  // pauses the home setup/closure cards only. The honesty layer (claim-review
  // buttons, subtitles, menu row) never reads it — switching persuasion off
  // must not reintroduce the lies those surfaces repair.
  { key: "ESIGN_NUDGES_OFF", group: "esign", type: "boolean", onValue: "1" },

  // --- Firebase auth --------------------------------------------------------
  // A Firebase web API key is a PUBLIC client identifier (relayed to every
  // browser by firebaseWebConfig), not a secret — shown, like the other
  // Firebase fields, so the admin can verify it. The provider keys above are
  // the real secrets.
  { key: "FIREBASE_API_KEY", group: "firebase", type: "text" },
  { key: "FIREBASE_AUTH_DOMAIN", group: "firebase", type: "text", placeholder: "project.firebaseapp.com" },
  { key: "FIREBASE_PROJECT_ID", group: "firebase", type: "text" },
  { key: "FIREBASE_APP_ID", group: "firebase", type: "text" },
  { key: "FIREBASE_AUTH_PROXY", group: "firebase", type: "boolean", onValue: "1" },
  { key: "FIREBASE_AUTH_UPSTREAM_HOST", group: "firebase", type: "text" },
] as const;

export const ADMIN_CONFIG_GROUPS = ["ai", "deployment", "esign", "firebase"] as const;
export type AdminConfigGroup = (typeof ADMIN_CONFIG_GROUPS)[number];

const BY_KEY = new Map(ADMIN_CONFIG_FIELDS.map((f) => [f.key, f]));

export function adminConfigField(key: string): AdminConfigField | undefined {
  return BY_KEY.get(key);
}

/** Validate + normalize a submitted value for a field. Throws on a bad value;
 *  returns the string to store, or null to delete the key. Empty text clears a
 *  key; empty secret means "leave unchanged" (handled by the caller). */
export function normalizeConfigValue(field: AdminConfigField, raw: unknown): string | null {
  if (typeof raw !== "string") throw new Error(`${field.key} must be a string`);
  const value = raw.trim();
  if (value === "") return null;
  switch (field.type) {
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${field.key} must be a whole number`);
      if (field.min !== undefined && n < field.min) throw new Error(`${field.key} must be ≥ ${field.min}`);
      if (field.max !== undefined && n > field.max) throw new Error(`${field.key} must be ≤ ${field.max}`);
      return String(n);
    }
    case "boolean":
      // The checkbox sends the onValue when on and "" when off (cleared above).
      return field.onValue ?? "1";
    case "select":
      if (field.options && !field.options.includes(value)) throw new Error(`${field.key} must be one of ${field.options.join(", ")}`);
      return value;
    default: {
      const err = field.validate?.(value);
      if (err) throw new Error(err);
      return value;
    }
  }
}
