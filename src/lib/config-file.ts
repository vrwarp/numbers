import fs from "fs";
import path from "path";

/**
 * Optional overlay of environment settings read from a JSON file on the data
 * volume, so a deployment can be reconfigured by editing a file under DATA_DIR
 * instead of relaunching the container with new env vars. SERVER ONLY (fs).
 *
 * The file maps env-var names to string values, e.g.
 *   { "AI_PROVIDER": "google", "GEMINI_API_KEY": "sk-...", "AI_RPM_TARGET": "10" }
 *
 * File values take precedence over process.env; only DATA_DIR is exempt — it
 * locates this very file, so it must come from the real environment. The file
 * is reloaded when its mtime changes, so edits take effect without a restart
 * (matching the "read fresh per call" behavior of the AI knobs in config.ts).
 */

export const CONFIG_FILE_NAME = "config.json";

/** DATA_DIR points at the config file itself, so it can never come from it. */
const BOOTSTRAP_ONLY = new Set(["DATA_DIR"]);

function configFilePath(): string {
  const dir = path.resolve(process.env.DATA_DIR || "./data");
  return path.join(dir, CONFIG_FILE_NAME);
}

let cache: { mtimeMs: number; values: Record<string, string> } | null = null;

function loadFileConfig(): Record<string, string> {
  const file = configFilePath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = null; // no file (or unreadable) → env-only
    return {};
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.values;

  let values: Record<string, string> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
        if (raw === null || raw === undefined) continue;
        values[key] = typeof raw === "string" ? raw : String(raw);
      }
    }
  } catch {
    values = {}; // malformed JSON → ignore the file, fall back to env
  }
  cache = { mtimeMs: stat.mtimeMs, values };
  return values;
}

/**
 * Resolve an env-style setting: the DATA_DIR config file wins when it defines
 * the key, otherwise process.env. Returns undefined when neither supplies it.
 */
export function configValue(name: string): string | undefined {
  if (!BOOTSTRAP_ONLY.has(name)) {
    const fromFile = loadFileConfig()[name];
    if (fromFile !== undefined) return fromFile;
  }
  return process.env[name];
}
