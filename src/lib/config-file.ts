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

function warnBadConfigFile(file: string, detail: string): void {
  console.warn(
    `config.json at ${file} could not be used (${detail}); ignoring it and ` +
      `falling back to process.env. Fix the file so its settings take effect.`
  );
}

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
    } else {
      // Valid JSON but not a `{ "KEY": "value" }` object (e.g. an array or a
      // bare value): every key is ignored. Warn so this isn't silent — a
      // deployment with only config.json settings would otherwise look
      // entirely "unconfigured" (e.g. "No sign-in method is configured").
      values = {};
      warnBadConfigFile(file, "expected a JSON object of KEY: \"value\" pairs");
    }
  } catch (err) {
    // A single JSON syntax error (a trailing comma, an unescaped newline in a
    // pasted service-account key, a missing quote) makes the WHOLE file fall
    // back to env-only. Silently swallowing it stranded operators who had set,
    // e.g., the Firebase keys here yet still saw "not configured". Surface it —
    // the mtime cache below means this warns once per edit, not per request.
    values = {};
    warnBadConfigFile(file, err instanceof Error ? err.message : String(err));
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

/** True when a key is set by the config FILE (not process.env). */
export function configFileHas(name: string): boolean {
  return loadFileConfig()[name] !== undefined;
}

/** Absolute path of the config file (for surfacing it to the admin). */
export function configFilePathPublic(): string {
  return configFilePath();
}

/**
 * Read the config file's own values, without the process.env overlay — the
 * source of truth the admin editor writes back. Returns {} when absent.
 * SERVER ONLY.
 */
export function readConfigFile(): Record<string, string> {
  return { ...loadFileConfig() };
}

/**
 * Merge `updates` into `<DATA_DIR>/config.json` and write it back. A `null`
 * value deletes the key (falls back to process.env / the built-in default);
 * a string sets it. Creates the file (and DATA_DIR) if missing. The mtime
 * cache picks up the new file on the next read, so changes apply without a
 * restart — matching `configValue`'s hot-read contract. SERVER ONLY (fs).
 */
export function writeConfigValues(updates: Record<string, string | null>): void {
  if (BOOTSTRAP_ONLY.has("DATA_DIR") && "DATA_DIR" in updates) {
    // DATA_DIR locates this very file; it can never be written into it.
    delete updates.DATA_DIR;
  }
  const file = configFilePath();
  const current = (() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // missing or malformed → start clean
    }
    return {} as Record<string, unknown>;
  })();

  for (const [key, value] of Object.entries(updates)) {
    if (value === null) delete current[key];
    else current[key] = value;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  cache = null; // force a re-read on the next configValue() call
}
