"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { LOCALES, LOCALE_COOKIE, LOCALE_LABELS } from "@/lib/locales";

/**
 * Language picker (NavBar + sign-in page). The cookie is the runtime source
 * of truth — written here, read by src/i18n/request.ts on the refresh; when
 * signed in the choice is also persisted to User.locale so it follows the
 * user to their next device (sign-in copies it back into the cookie).
 */
export default function LocaleSwitcher({
  signedIn = false,
  className = "",
}: {
  signedIn?: boolean;
  className?: string;
}) {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("Common");

  function change(next: string) {
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${365 * 24 * 60 * 60}; samesite=lax`;
    if (signedIn) {
      fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next }),
      }).catch(() => {});
    }
    router.refresh();
  }

  return (
    <select
      className={`rounded-lg border border-transparent bg-transparent px-1.5 py-1.5 text-sm text-stone-500 hover:bg-stone-100 ${className}`}
      value={locale}
      onChange={(e) => change(e.target.value)}
      aria-label={t("language")}
      data-testid="locale-switcher"
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_LABELS[l]}
        </option>
      ))}
    </select>
  );
}
