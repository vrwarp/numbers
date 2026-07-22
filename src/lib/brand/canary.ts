import { configValue } from "@/lib/config-file";

/**
 * Canary-instance marker (CANARY, admin-editable under Admin → Settings).
 *
 * When on, the whole brand is repainted amber — the in-app wordmark grows a
 * badge, the favicon / PWA / apple-touch icons get a corner flag, the web
 * manifest name and theme color change, and the browser-tab title is prefixed
 * — so a non-production instance is unmistakable at a glance and nobody files
 * (or approves) a real claim against it by mistake.
 *
 * Read fresh per call (via configValue, an fs overlay) so a config.json toggle
 * applies without a restart, matching the other deployment knobs. SERVER ONLY.
 */
export function isCanary(): boolean {
  return configValue("CANARY") === "1";
}

/** Amber (Tailwind amber-500) the canary brand paints with — icon flag, theme
 *  color, manifest. Kept beside the default so both live in one place. */
export const CANARY_THEME_COLOR = "#f59e0b";

/** The production indigo (Tailwind indigo-600) theme color. */
export const DEFAULT_THEME_COLOR = "#4f46e5";
