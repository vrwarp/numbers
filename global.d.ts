import type en from "./messages/en.json";
import type { LOCALES } from "./src/lib/locales";

/**
 * Every t("…") key is type-checked against the English catalog — a typo'd or
 * deleted key fails `npm run build`, not the user's screen.
 */
declare module "next-intl" {
  interface AppConfig {
    Locale: (typeof LOCALES)[number];
    Messages: typeof en;
  }
}
