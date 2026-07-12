/**
 * Shared helpers for the translation pipeline: the parity/staleness unit test
 * and scripts/translate-messages.ts must agree on flattening and ICU-argument
 * extraction, so they live here (pure functions, no fs).
 */

export type Messages = { [key: string]: string | Messages };

export type TranslationStatus = "todo" | "machine" | "reviewed";

/**
 * One entry per key in messages/translation-state.json. `source` is the
 * verbatim English the translations were made from — kept as readable text
 * (not a hash) so an entry is self-contained: key, English, translator hint,
 * and per-locale review status all read together. Staleness is simply
 * `entry.source !== en.json's current value`.
 */
export interface StateEntry {
  source: string;
  /** Optional translator note (what/where the string is) fed into drafting prompts. */
  context?: string;
  "zh-Hans"?: TranslationStatus;
  "zh-Hant"?: TranslationStatus;
}

export type TranslationState = Record<string, StateEntry>;

export function flatten(obj: Messages, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(full, value);
    else for (const [k, v] of flatten(value, full)) out.set(k, v);
  }
  return out;
}

/** Rebuild the nested catalog shape from a flat map, following en's key order. */
export function unflatten(flat: Map<string, string>, order: string[]): Messages {
  const out: Messages = {};
  for (const key of order) {
    const value = flat.get(key);
    if (value === undefined) continue;
    const parts = key.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) {
      node = (node[part] ??= {}) as Messages;
    }
    node[parts[parts.length - 1]] = value;
  }
  return out;
}

/** ICU argument names ({count}, {merchant, plural, …}) + rich tags (<link>). */
export function messageArguments(message: string): string[] {
  const args = new Set<string>();
  for (const m of message.matchAll(/\{\s*([a-zA-Z0-9_]+)\s*[,}]/g)) args.add(`{${m[1]}}`);
  for (const m of message.matchAll(/<([a-z][a-zA-Z0-9]*)>/g)) args.add(`<${m[1]}>`);
  return [...args].sort();
}
