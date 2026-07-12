/**
 * The app's locales. Script subtags on purpose: the Traditional-Chinese
 * audience spans Taiwan AND Hong Kong, so zh-Hant names the script without
 * picking a region (zh-TW and zh-HK browsers both negotiate onto it).
 * Dependency-free and client-safe (imported by client components, the
 * next-intl request config, and API routes alike).
 */
export const LOCALES = ["en", "zh-Hans", "zh-Hant"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Runtime source of truth for the UI language; User.locale is the durable copy. */
export const LOCALE_COOKIE = "numbers_locale";

/** Self-named — a language's own name is never translated. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
};

/** One-glyph badges for the NavBar's compact switcher chip. */
export const LOCALE_SHORT_LABELS: Record<Locale, string> = {
  en: "EN",
  "zh-Hans": "简",
  "zh-Hant": "繁",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Minimal Accept-Language negotiation: first tag that maps onto a supported
 * locale wins (browsers already order tags by preference; q-values ignored).
 * zh-TW/HK/MO and zh-Hant* → zh-Hant; every other zh variant → zh-Hans.
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  for (const part of (acceptLanguage ?? "").split(",")) {
    const tag = part.split(";")[0].trim().toLowerCase();
    if (!tag) continue;
    if (tag === "zh-tw" || tag === "zh-hk" || tag === "zh-mo" || tag.startsWith("zh-hant")) {
      return "zh-Hant";
    }
    if (tag === "zh" || tag.startsWith("zh-")) return "zh-Hans";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return DEFAULT_LOCALE;
}
