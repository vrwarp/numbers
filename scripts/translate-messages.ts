/**
 * Translation pipeline for messages/*.json (run: `npm run translate [-- flags]`).
 *
 *   (default)      draft missing keys in each Chinese catalog via the
 *                  configured AI provider (AI_PROVIDER + its API key — the
 *                  same plumbing extraction uses)
 *   --todo         no AI: fill missing keys with the English text (renders as
 *                  a fallback, tracked as status "todo")
 *   --stale        also re-draft keys whose English source changed since the
 *                  last run (entry.source in translation-state.json no longer
 *                  matches en.json)
 *   --all          re-draft every machine-status key (after a glossary change)
 *   --sync-state   no AI: reconcile translation-state.json with the catalogs
 *                  (adopt hand-written translations as "machine", track gaps
 *                  as "todo", refresh sources, prune orphans)
 *   --force        allow re-drafting keys a human already marked "reviewed"
 *                  (they are otherwise reported and skipped)
 *
 * Review workflow: a bilingual reviewer edits the catalog value if needed and
 * flips the key's status to "reviewed" in translation-state.json — the next
 * runs will never overwrite it without --force. English rewording flips the
 * staleness gate in tests/unit/messages.test.ts until this script is re-run.
 */
import fs from "node:fs";
import path from "node:path";
import {
  QUOTED_IN,
  SAME_VALUE_GROUPS,
  flatten,
  messageArguments,
  unflatten,
  type Messages,
  type StateEntry,
  type TranslationState,
  type TranslationStatus,
} from "../src/lib/translation-state";

const MESSAGES_DIR = path.join(process.cwd(), "messages");
const STATE_FILE = path.join(MESSAGES_DIR, "translation-state.json");
const TARGET_LOCALES = ["zh-Hans", "zh-Hant"] as const;
type TargetLocale = (typeof TARGET_LOCALES)[number];

const LANGUAGE_NAMES: Record<TargetLocale, string> = {
  "zh-Hans": "Simplified Chinese (audience: people from mainland China)",
  "zh-Hant": "Traditional Chinese (audience: people from Taiwan and Hong Kong; Taiwan vocabulary — 登入, 儲存, 套用)",
};

const flags = new Set(process.argv.slice(2));
const MODE = {
  todo: flags.has("--todo"),
  stale: flags.has("--stale"),
  all: flags.has("--all"),
  syncState: flags.has("--sync-state"),
  force: flags.has("--force"),
};

function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const en = flatten(readJson<Messages>(path.join(MESSAGES_DIR, "en.json"), {}));
const enOrder = [...en.keys()];
if (en.size === 0) throw new Error("messages/en.json is missing or empty");

const state = readJson<TranslationState>(STATE_FILE, {});
const catalogs = new Map<TargetLocale, Map<string, string>>();
for (const locale of TARGET_LOCALES) {
  catalogs.set(
    locale,
    flatten(readJson<Messages>(path.join(MESSAGES_DIR, `${locale}.json`), {}))
  );
}

// ---- prune keys that left en.json ----
for (const key of Object.keys(state)) {
  if (!en.has(key)) delete state[key];
}
for (const flat of catalogs.values()) {
  for (const key of [...flat.keys()]) {
    if (!en.has(key)) flat.delete(key);
  }
}

/**
 * Canonical entry shape (field order is the readable order: English source,
 * translator hint, per-locale statuses). Rebuilding on every write also
 * drops legacy fields from older state formats.
 */
function canonical(key: string, prev: StateEntry | undefined): StateEntry {
  const e: StateEntry = { source: en.get(key)! };
  if (prev?.context) e.context = prev.context;
  for (const locale of TARGET_LOCALES) {
    if (prev?.[locale]) e[locale] = prev[locale];
  }
  return e;
}

// Same-value members are never drafted — they copy their group's canonical.
const SAME_VALUE_MEMBER = new Map<string, string>();
for (const [canonical, ...members] of SAME_VALUE_GROUPS) {
  for (const member of members) SAME_VALUE_MEMBER.set(member, canonical);
}
// Messages that quote another key draft AFTER it, with its live translation inlined.
const QUOTES_BY_MESSAGE = new Map(QUOTED_IN.map((q) => [q.message, q]));

function quotedValue(flat: Map<string, string>, quotes: string, strip?: string): string {
  let value = flat.get(quotes) ?? en.get(quotes)!;
  if (strip && value.startsWith(strip)) value = value.slice(strip.length);
  return value;
}

interface DraftExtras {
  /** Exact current translation of a UI element quoted inside this message. */
  mustContain?: string;
}

async function draft(
  locale: TargetLocale,
  keys: string[],
  extras?: Map<string, DraftExtras>
): Promise<Map<string, string>> {
  if (MODE.todo) return new Map(keys.map((k) => [k, en.get(k)!]));

  const { callProvider, currentProvider, providerApiKey, providerModel } = await import(
    "../src/lib/ai/providers"
  );
  const provider = currentProvider();
  const apiKey = providerApiKey(provider);
  const model = providerModel(provider);
  const glossary = fs.readFileSync(path.join(MESSAGES_DIR, "GLOSSARY.md"), "utf8");

  const out = new Map<string, string>();
  const BATCH = 25;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const items = batch.map((key) => ({
      key,
      en: en.get(key)!,
      context: state[key]?.context,
      previous: catalogs.get(locale)!.get(key),
      ...extras?.get(key),
    }));
    const prompt = [
      `Translate these UI strings for a church expense-reimbursement app into ${LANGUAGE_NAMES[locale]}.`,
      "",
      "Rules:",
      "- Follow the glossary below EXACTLY for its terms.",
      "- Keep every ICU argument ({name}, {count, plural, ...}) and every rich-text tag (<link>, <strong>, <code>, <step>) verbatim; translate only the surrounding text. Chinese needs no plural branches — `{count, plural, other {...}}` is fine.",
      "- Keep leading/trailing punctuation and symbols (…, ✨, 📷, ↑, →, ⑂, ⤴, ↩, ⬇, ＋, $) in place.",
      '- "previous" is the prior translation of an older English source — preserve its terminology where still accurate.',
      '- "context" is a translator note about where the string appears.',
      '- "mustContain" is the exact current translation of a UI element this message quotes — it must appear VERBATIM inside your translation.',
      "- Answer with ONLY a JSON object mapping each key to its translation.",
      "",
      "GLOSSARY:",
      glossary,
      "",
      "STRINGS:",
      JSON.stringify(items, null, 2),
    ].join("\n");

    const text = await callProvider(provider, apiKey, model, prompt);
    const jsonText = text.replace(/^[^{]*/, "").replace(/[^}]*$/, "");
    const parsed = JSON.parse(jsonText) as Record<string, string>;
    for (const key of batch) {
      const value = parsed[key];
      const mustContain = extras?.get(key)?.mustContain;
      const argsMatch =
        typeof value === "string" &&
        JSON.stringify(messageArguments(value)) === JSON.stringify(messageArguments(en.get(key)!));
      const quoteMatch = !mustContain || (typeof value === "string" && value.includes(mustContain));
      if (argsMatch && quoteMatch) {
        out.set(key, value);
      } else {
        const why = argsMatch ? `missing quoted wording ${JSON.stringify(mustContain)}` : "bad/missing draft";
        console.warn(`  ✗ ${locale} ${key}: ${why} — falling back to English (todo)`);
        out.set(key, en.get(key)!);
      }
    }
    console.log(`  ${locale}: drafted ${Math.min(i + BATCH, keys.length)}/${keys.length}`);
  }
  return out;
}

/** Mirror each group's canonical value + status onto its members. */
function copySameValueMembers(locale: TargetLocale): void {
  const flat = catalogs.get(locale)!;
  for (const [canonicalKey, ...members] of SAME_VALUE_GROUPS) {
    for (const member of members) {
      flat.set(member, flat.get(canonicalKey) ?? en.get(member)!);
      const e = (state[member] = canonical(member, state[member]));
      e[locale] = state[canonicalKey]?.[locale] ?? "todo";
    }
  }
}

// Spec sanity: shallow dependencies only — a quoted key must be independently
// draftable (not itself a quoting message or a copied member).
for (const { message, quotes } of QUOTED_IN) {
  if (QUOTES_BY_MESSAGE.has(quotes) || SAME_VALUE_MEMBER.has(quotes)) {
    throw new Error(`QUOTED_IN: ${message} quotes ${quotes}, which is not independently drafted`);
  }
  if (SAME_VALUE_MEMBER.has(message)) {
    throw new Error(`QUOTED_IN: ${message} is a same-value member — quote via its canonical`);
  }
}

async function main() {
  const reviewedSkipped: string[] = [];

  for (const locale of TARGET_LOCALES) {
    const flat = catalogs.get(locale)!;

    if (MODE.syncState) {
      for (const key of enOrder) {
        if (SAME_VALUE_MEMBER.has(key)) continue; // reconciled from canonical below
        const e = (state[key] = canonical(key, state[key]));
        e[locale] ??= flat.has(key) ? "machine" : "todo";
        if (!flat.has(key)) {
          flat.set(key, en.get(key)!); // visible English fallback, tracked as todo
          e[locale] = "todo";
        }
      }
      copySameValueMembers(locale);
      continue;
    }

    const work: string[] = [];
    for (const key of enOrder) {
      if (SAME_VALUE_MEMBER.has(key)) continue; // copied from canonical, never drafted
      const status: TranslationStatus | undefined = state[key]?.[locale];
      const missing = !flat.has(key) || status === "todo";
      const stale = state[key] !== undefined && state[key].source !== en.get(key);
      const machineRedraft = MODE.all && status === "machine";
      if (!missing && !((MODE.stale || MODE.all) && stale) && !machineRedraft) continue;
      if (status === "reviewed" && !MODE.force) {
        if (stale) reviewedSkipped.push(`${locale}: ${key}`);
        continue;
      }
      work.push(key);
    }

    if (work.length === 0) {
      console.log(`${locale}: nothing to do`);
      copySameValueMembers(locale);
      continue;
    }
    // Dependency order: keys whose wording others quote draft first, so the
    // second pass can inline their FRESH translations as mustContain.
    const pass1 = work.filter((key) => !QUOTES_BY_MESSAGE.has(key));
    const pass2 = work.filter((key) => QUOTES_BY_MESSAGE.has(key));
    console.log(`${locale}: ${MODE.todo ? "filling" : "drafting"} ${work.length} key(s)…`);
    const apply = (drafted: Map<string, string>) => {
      for (const [key, value] of drafted) {
        flat.set(key, value);
        const e = (state[key] = canonical(key, state[key]));
        e[locale] = MODE.todo || value === en.get(key) ? "todo" : "machine";
      }
    };
    apply(await draft(locale, pass1));
    if (pass2.length > 0) {
      const extras = new Map(
        pass2.map((key) => {
          const { quotes, strip } = QUOTES_BY_MESSAGE.get(key)!;
          return [key, { mustContain: quotedValue(flat, quotes, strip) }];
        })
      );
      apply(await draft(locale, pass2, extras));
    }
    copySameValueMembers(locale);
  }

  for (const locale of TARGET_LOCALES) {
    writeJson(path.join(MESSAGES_DIR, `${locale}.json`), unflatten(catalogs.get(locale)!, enOrder));
  }
  // Rewrite every entry in canonical shape and en order; `source` always
  // reflects the English the catalogs were just synced against.
  const sortedState: TranslationState = {};
  for (const key of enOrder) sortedState[key] = canonical(key, state[key]);
  writeJson(STATE_FILE, sortedState);

  if (reviewedSkipped.length > 0) {
    console.warn(
      `\n${reviewedSkipped.length} reviewed key(s) are STALE and were left alone (re-run with --force or fix by hand):`
    );
    for (const line of reviewedSkipped) console.warn(`  ${line}`);
  }
  console.log("\nCatalogs + translation-state.json written.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
