import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { LOCALE_COOKIE, isLocale, type Locale } from "@/lib/locales";

/**
 * Set the locale cookie from a route handler (sign-in persists the stored
 * preference to the new device). Deliberately NOT httpOnly: the client-side
 * language switcher writes the same cookie directly, so pre-auth visitors can
 * switch without an API round-trip.
 */
export async function setLocaleCookie(locale: Locale): Promise<void> {
  (await cookies()).set(LOCALE_COOKIE, locale, {
    sameSite: "lax",
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
  });
}

/**
 * Sign-in reconciliation: a language explicitly chosen on this device
 * (cookie) wins and is persisted to the account; otherwise the stored
 * preference is copied onto the device, so signing in on a new phone
 * restores the user's language.
 */
export async function syncLocalePreference(userId: string, stored: string): Promise<void> {
  const cookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(cookie)) {
    if (cookie !== stored) {
      await prisma.user.update({ where: { id: userId }, data: { locale: cookie } });
    }
    return;
  }
  if (isLocale(stored)) await setLocaleCookie(stored);
}
