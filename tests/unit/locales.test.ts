import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_LABELS,
  LOCALE_SHORT_LABELS,
  isLocale,
  negotiateLocale,
} from "@/lib/locales";

describe("locale constants", () => {
  it("the three supported locales with English as default", () => {
    expect(LOCALES).toEqual(["en", "zh-Hans", "zh-Hant"]);
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("labels are self-named for every locale", () => {
    for (const l of LOCALES) {
      expect(LOCALE_LABELS[l]).toBeTruthy();
      expect(LOCALE_SHORT_LABELS[l]).toBeTruthy();
    }
    expect(LOCALE_LABELS.en).toBe("English");
    expect(LOCALE_SHORT_LABELS["zh-Hant"]).toBe("繁");
  });
});

describe("isLocale", () => {
  const cases: [unknown, boolean][] = [
    ["en", true],
    ["zh-Hans", true],
    ["zh-Hant", true],
    ["EN", false], // case-sensitive
    ["fr", false],
    ["zh", false], // bare zh is not a catalog
    ["", false],
    [null, false],
    [undefined, false],
    [42, false],
    [{}, false],
  ];
  it.each(cases)("isLocale(%o) → %s", (val, want) => {
    expect(isLocale(val)).toBe(want);
  });
});

describe("negotiateLocale", () => {
  const cases: [string | null | undefined, string][] = [
    [null, "en"], // missing header → default
    [undefined, "en"],
    ["", "en"],
    ["   ", "en"], // only blank tags
    ["en", "en"],
    ["en-US", "en"],
    ["en-GB,en;q=0.9", "en"],
    ["zh", "zh-Hans"], // bare zh → Simplified
    ["zh-CN", "zh-Hans"],
    ["zh-Hans", "zh-Hans"],
    ["zh-SG", "zh-Hans"],
    ["zh-TW", "zh-Hant"],
    ["zh-HK", "zh-Hant"],
    ["zh-MO", "zh-Hant"],
    ["zh-Hant", "zh-Hant"],
    ["zh-Hant-HK", "zh-Hant"], // startsWith zh-hant
    ["ZH-tw", "zh-Hant"], // case-insensitive
    ["fr-FR,de", "en"], // no supported tag → default
    ["fr,zh-TW", "zh-Hant"], // first supported tag wins
    ["fr,en-US,zh-TW", "en"], // en precedes zh-TW here
    ["en-US;q=0.1,zh-TW;q=0.9", "en"], // q-values ignored, order rules
  ];
  it.each(cases)("negotiateLocale(%o) → %s", (header, want) => {
    expect(negotiateLocale(header)).toBe(want);
  });
});
