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

async function draft(locale: TargetLocale, keys: string[]): Promise<Map<string, string>> {
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
      const argsMatch =
        typeof value === "string" &&
        JSON.stringify(messageArguments(value)) === JSON.stringify(messageArguments(en.get(key)!));
      if (argsMatch) {
        out.set(key, value);
      } else {
        console.warn(`  ✗ ${locale} ${key}: bad/missing draft — falling back to English (todo)`);
        out.set(key, en.get(key)!);
      }
    }
    console.log(`  ${locale}: drafted ${Math.min(i + BATCH, keys.length)}/${keys.length}`);
  }
  return out;
}

async function main() {
  const reviewedSkipped: string[] = [];

  for (const locale of TARGET_LOCALES) {
    const flat = catalogs.get(locale)!;

    if (MODE.syncState) {
      for (const key of enOrder) {
        const e = (state[key] = canonical(key, state[key]));
        e[locale] ??= flat.has(key) ? "machine" : "todo";
        if (!flat.has(key)) {
          flat.set(key, en.get(key)!); // visible English fallback, tracked as todo
          e[locale] = "todo";
        }
      }
      continue;
    }

    const work: string[] = [];
    for (const key of enOrder) {
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
      continue;
    }
    console.log(`${locale}: ${MODE.todo ? "filling" : "drafting"} ${work.length} key(s)…`);
    const drafted = await draft(locale, work);
    for (const [key, value] of drafted) {
      flat.set(key, value);
      const e = (state[key] = canonical(key, state[key]));
      e[locale] = MODE.todo || value === en.get(key) ? "todo" : "machine";
    }
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
