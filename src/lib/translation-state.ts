import { createHash } from "crypto";

/**
 * Shared helpers for the translation pipeline: the parity/staleness unit test
 * and scripts/translate-messages.ts must agree on hashing, flattening, and
 * ICU-argument extraction, so they live here (pure functions, no fs).
 */

export type Messages = { [key: string]: string | Messages };

export type TranslationStatus = "todo" | "machine" | "reviewed";

export interface StateEntry {
  /** Hash of the English source this key's translations were made from. */
  sourceHash: string;
  "zh-Hans"?: TranslationStatus;
  "zh-Hant"?: TranslationStatus;
  /** Optional translator note fed into the drafting prompt. */
  context?: string;
}

export type TranslationState = Record<string, StateEntry>;

export function sourceHash(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex").slice(0, 8);
}

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
