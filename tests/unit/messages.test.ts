import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { LOCALES } from "@/lib/locales";
import { flatten, messageArguments, type Messages, type TranslationState } from "@/lib/translation-state";

/**
 * Catalog integrity. en.json is the source of truth; every other catalog must
 * mirror its key set and each message's ICU arguments / rich-text tags — a
 * missing or drifted translation is a red build, not a silent English leak
 * (or worse, a stale Chinese one). translation-state.json (written by
 * `npm run translate`) additionally records the verbatim English source each
 * translation was made from, so rewording English without re-running the
 * translation script fails here — with both versions in the failure output.
 */

const MESSAGES_DIR = path.join(process.cwd(), "messages");
const STATE_FILE = path.join(MESSAGES_DIR, "translation-state.json");

function loadCatalog(locale: string): Messages | null {
  const file = path.join(MESSAGES_DIR, `${locale}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const en = loadCatalog("en");
const enFlat = flatten(en!);

describe("message catalogs", () => {
  it("en.json exists and has no empty messages", () => {
    expect(en).not.toBeNull();
    for (const [key, value] of enFlat) {
      expect(value.trim(), `en: ${key} is empty`).not.toBe("");
    }
  });

  for (const locale of LOCALES.filter((l) => l !== "en")) {
    const catalog = loadCatalog(locale);
    // Chinese catalogs arrive with the translation pipeline; until then a
    // missing file is allowed. Once present it must mirror en exactly.
    if (!catalog) continue;

    describe(locale, () => {
      const flat = flatten(catalog);

      it("has exactly the same keys as en.json", () => {
        const missing = [...enFlat.keys()].filter((k) => !flat.has(k));
        const extra = [...flat.keys()].filter((k) => !enFlat.has(k));
        expect(missing, `missing keys in ${locale}`).toEqual([]);
        expect(extra, `orphan keys in ${locale} (removed from en?)`).toEqual([]);
      });

      it("keeps every message's ICU arguments and rich-text tags", () => {
        for (const [key, enValue] of enFlat) {
          const value = flat.get(key);
          if (value === undefined) continue; // covered by the key test
          expect(messageArguments(value), `${locale}: ${key} arguments drifted`).toEqual(
            messageArguments(enValue)
          );
        }
      });

      it("has no empty messages", () => {
        for (const [key, value] of flat) {
          expect(value.trim(), `${locale}: ${key} is empty`).not.toBe("");
        }
      });
    });
  }

  it("translations are not stale (translation-state source matches en)", () => {
    if (!fs.existsSync(STATE_FILE)) return; // arrives with the Chinese catalogs
    const state: TranslationState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const stale: string[] = [];
    for (const [key, entry] of Object.entries(state)) {
      const enValue = enFlat.get(key);
      if (enValue !== undefined && entry.source !== enValue) {
        stale.push(`${key}\n  translated from: ${JSON.stringify(entry.source)}\n  en.json now:     ${JSON.stringify(enValue)}`);
      }
    }
    expect(stale, "English changed since translation — run `npm run translate`").toEqual([]);
    const untracked = [...enFlat.keys()].filter((k) => !(k in state));
    expect(untracked, "keys missing from translation-state — run `npm run translate`").toEqual(
      []
    );
  });
});
