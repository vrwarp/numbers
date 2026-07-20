/**
 * Setup-wizard definitions (docs/ADMIN.md). Client-safe and dependency-free:
 * which services have a guided setup, their ordered steps, the fields each
 * step edits, and whether the step exposes a "Test this step" dry run
 * (validated server-side by /api/admin/setup/validate). Config-backed wizards
 * save through the allowlisted config editor; the search wizard talks to the
 * embeddings backend (its config lives in a DB row, not config.json).
 */

export type WizardService = "push" | "ai" | "firebase" | "search";
export type WizardBackend = "config" | "search";

export type WizardStep = {
  id: string;
  /** Config keys (config backend) or search field keys (search backend). */
  fieldKeys: string[];
  /** Whether this step exposes a dry-run "Test this step" action. */
  test: boolean;
};

/** Field metadata for the search backend (config fields come from the config GET). */
export type SearchFieldDef = {
  key: string;
  type: "text" | "number" | "boolean" | "select";
  secret?: boolean;
  min?: number;
  max?: number;
  onValue?: string;
  placeholder?: string;
};

export type Wizard = {
  service: WizardService;
  backend: WizardBackend;
  /** Emoji marker for the launcher card (also its favicon-ish glyph). */
  icon: string;
  steps: WizardStep[];
  searchFields?: SearchFieldDef[];
  /** Config keys whose "set" state marks the service configured, for the
   *  launcher's status badge. Search uses its own GET (handled in the tab). */
  configuredKeys?: string[];
};

export const WIZARDS: Wizard[] = [
  {
    service: "push",
    backend: "config",
    icon: "🔔",
    configuredKeys: ["FCM_SERVICE_ACCOUNT_JSON", "FIREBASE_VAPID_PUBLIC_KEY"],
    steps: [
      { id: "keys", fieldKeys: ["FIREBASE_MESSAGING_SENDER_ID", "FIREBASE_VAPID_PUBLIC_KEY"], test: true },
      { id: "account", fieldKeys: ["FCM_SERVICE_ACCOUNT_JSON"], test: true },
      { id: "delivery", fieldKeys: ["NOTIFY_QUIET", "NOTIFY_PAUSED"], test: true },
    ],
  },
  {
    service: "ai",
    backend: "config",
    icon: "🧾",
    configuredKeys: ["OPENROUTER_API_KEY", "GEMINI_API_KEY"],
    steps: [
      { id: "provider", fieldKeys: ["AI_PROVIDER"], test: false },
      {
        id: "credentials",
        fieldKeys: ["OPENROUTER_API_KEY", "OPENROUTER_MODEL", "GEMINI_API_KEY", "GEMINI_MODEL"],
        test: true,
      },
      { id: "limits", fieldKeys: ["AI_RPM_TARGET", "AI_QUOTA_COOLDOWN_MS", "AI_QUOTA_MAX_RETRIES"], test: false },
    ],
  },
  {
    service: "firebase",
    backend: "config",
    icon: "🔑",
    configuredKeys: ["FIREBASE_API_KEY", "FIREBASE_PROJECT_ID"],
    steps: [
      {
        id: "webconfig",
        fieldKeys: ["FIREBASE_API_KEY", "FIREBASE_AUTH_DOMAIN", "FIREBASE_PROJECT_ID", "FIREBASE_APP_ID"],
        test: true,
      },
      { id: "ios", fieldKeys: ["FIREBASE_AUTH_PROXY", "PUBLIC_BASE_URL"], test: true },
    ],
  },
  {
    service: "search",
    backend: "search",
    icon: "🔍",
    searchFields: [
      { key: "endpoint", type: "text", placeholder: "https://embeddings.example.org" },
      { key: "model", type: "text", placeholder: "qwen3-vl-embedding-2b" },
      { key: "apiKey", type: "text", secret: true },
      { key: "enabled", type: "boolean", onValue: "1" },
      { key: "minScore", type: "number", min: 0, max: 1 },
    ],
    steps: [
      { id: "endpoint", fieldKeys: ["endpoint", "model", "apiKey"], test: true },
      { id: "enable", fieldKeys: ["enabled", "minScore"], test: false },
    ],
  },
];

export function wizardFor(service: string): Wizard | undefined {
  return WIZARDS.find((w) => w.service === service);
}
