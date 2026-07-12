import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, negotiateLocale, type Locale } from "@/lib/locales";

/**
 * Locale resolution, no URL routing (every existing URL, bookmark and QR link
 * stays stable; the app is auth-gated so there is no SEO surface):
 *   1. numbers_locale cookie — set by the language switcher, and at sign-in
 *      from User.locale so the preference follows the user to a new device;
 *   2. Accept-Language negotiation for first visits;
 *   3. English.
 */
export async function resolveLocale(): Promise<Locale> {
  const cookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(cookie)) return cookie;
  const acceptLanguage = (await headers()).get("accept-language");
  const negotiated = negotiateLocale(acceptLanguage);
  return negotiated ?? DEFAULT_LOCALE;
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale();
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
