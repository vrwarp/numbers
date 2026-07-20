import { configValue } from "@/lib/config-file";
import { isAiMock } from "@/lib/config";
import { currentProvider, providerApiKey } from "@/lib/ai/providers";

/** Knobs + environment gates for the background annotation worker. */

/**
 * Minimum gap between two provider calls made by the WORKER — the "at most one
 * receipt per minute" drip (EXTRACTION_PACE_MS, default 60s). Deliberately slow
 * so the shared AI_RPM_TARGET budget stays available for user-initiated calls
 * (claim-time fallback extraction, ministry suggestions). 0 = no pacing (tests).
 * Read fresh per call so config.json edits re-pace without a restart.
 */
export function annotationPaceMs(): number {
  const raw = configValue("EXTRACTION_PACE_MS");
  if (raw === undefined || raw === "") return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 60_000;
}

/** Idle-poll interval of the worker loop (EXTRACTION_POLL_MS, default 15s) —
 *  the safety net behind wake-on-enqueue that picks up retries and restarts. */
export function extractionPollMs(): number {
  const raw = configValue("EXTRACTION_POLL_MS");
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 250 ? Math.floor(n) : 15_000;
}

/**
 * In dev, the worker requires an explicit opt-in so a .env holding a real
 * provider key never silently starts burning quota on a whole-shoebox backfill
 * from a laptop (the embedding worker's rule, docs/SEARCH_DESIGN.md §3.2).
 * Mock mode is always allowed — it is what dev and e2e run on.
 */
export function extractionAllowedInThisEnv(): boolean {
  if (isAiMock()) return true;
  if (process.env.NODE_ENV === "development") return configValue("EXTRACTION_DEV") === "1";
  return true;
}

/**
 * True when an extraction call can actually be made right now: mock mode, or a
 * provider with an API key configured. When false the worker idles instead of
 * burning every queued job into attempts-exhausted failures (and a pile of
 * error ExtractionLogs) on a deployment that simply hasn't configured AI yet.
 */
export function aiCallReady(): boolean {
  if (isAiMock()) return true;
  try {
    providerApiKey(currentProvider());
    return true;
  } catch {
    return false;
  }
}
