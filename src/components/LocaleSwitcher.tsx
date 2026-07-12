"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { LOCALES, LOCALE_COOKIE, LOCALE_LABELS, LOCALE_SHORT_LABELS } from "@/lib/locales";

/**
 * Language picker. The cookie is the runtime source of truth — written here,
 * read by src/i18n/request.ts on the refresh; when signed in the choice is
 * also persisted to User.locale so it follows the user to their next device
 * (sign-in copies it back into the cookie).
 *
 * Two looks: "full" (sign-in page) is a plain select showing the language's
 * own name; "compact" (NavBar) is a small chip showing a one-glyph badge
 * (EN / 简 / 繁) with an invisible native select stretched over it, so a tap
 * still opens the platform picker with the full language names — the chip
 * stays narrow enough for a phone-width nav with CJK link labels.
 */
export default function LocaleSwitcher({
  signedIn = false,
  variant = "full",
  className = "",
}: {
  signedIn?: boolean;
  variant?: "full" | "compact";
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

  const options = LOCALES.map((l) => (
    <option key={l} value={l}>
      {LOCALE_LABELS[l]}
    </option>
  ));

  if (variant === "compact") {
    return (
      <span
        className={`relative inline-flex shrink-0 items-center gap-0.5 rounded-lg px-2 py-1.5 text-sm text-stone-600 hover:bg-stone-100 ${className}`}
      >
        <span aria-hidden>{LOCALE_SHORT_LABELS[locale as keyof typeof LOCALE_SHORT_LABELS] ?? locale}</span>
        <span aria-hidden className="text-[10px] text-stone-400">
          ▾
        </span>
        <select
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          value={locale}
          onChange={(e) => change(e.target.value)}
          aria-label={t("language")}
          data-testid="locale-switcher"
        >
          {options}
        </select>
      </span>
    );
  }

  return (
    <select
      className={`rounded-lg border border-transparent bg-transparent px-1.5 py-1.5 text-sm text-stone-500 hover:bg-stone-100 ${className}`}
      value={locale}
      onChange={(e) => change(e.target.value)}
      aria-label={t("language")}
      data-testid="locale-switcher"
    >
      {options}
    </select>
  );
}
