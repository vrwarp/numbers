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
 * Four looks: "full" (sign-in page) is a plain select showing the language's
 * own name; "compact" (NavBar) is a small chip showing a one-glyph badge
 * (EN / 简 / 繁) with an invisible native select stretched over it, so a tap
 * still opens the platform picker with the full language names — the chip
 * stays narrow enough for a phone-width nav with CJK link labels; "row"
 * (account menu) is a full-width menu row — a "Language" label plus that same
 * badge chip — with the invisible select stretched over the WHOLE row, so a
 * tap anywhere on the row opens the picker like the sibling menu links do;
 * "prominent" (empty Receipts screen) is a segmented row of tappable pills,
 * each labelled with its language's own name, sized to catch a brand-new
 * user's eye.
 */
export default function LocaleSwitcher({
  signedIn = false,
  variant = "full",
  className = "",
}: {
  signedIn?: boolean;
  variant?: "full" | "compact" | "prominent" | "row";
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

  if (variant === "prominent") {
    // A quiet segmented control, not a loud toggle: a neutral stone track with
    // a soft white "selected" pill (indigo *text*, never a saturated fill that
    // would out-shout the page's real CTAs). The monochrome globe labels it as
    // a language picker at a glance without adding a color spot, so the native
    // language names can carry the meaning. Inactive options stay legible —
    // they are exactly what a non-English reader is looking for.
    return (
      <div
        className={`inline-flex items-center gap-0.5 rounded-full bg-stone-100 p-1 pl-3 ${className}`}
        role="group"
        aria-label={t("language")}
        data-testid="locale-switcher-prominent"
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mr-1.5 h-4 w-4 shrink-0 text-stone-400"
        >
          <circle cx="12" cy="12" r="9.5" />
          <path d="M2.5 12h19" />
          <path d="M12 2.5a15 15 0 0 1 0 19 15 15 0 0 1 0-19" />
        </svg>
        {LOCALES.map((l) => {
          const active = l === locale;
          return (
            <button
              key={l}
              type="button"
              onClick={() => change(l)}
              aria-current={active ? "true" : undefined}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-white text-indigo-700 shadow-sm"
                  : "text-stone-500 hover:text-stone-800"
              }`}
            >
              {LOCALE_LABELS[l]}
            </button>
          );
        })}
      </div>
    );
  }

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

  if (variant === "row") {
    // The select is stretched over the whole row (not just the chip), so a tap
    // anywhere — label included — opens the native picker, matching the plain
    // links above and below it. The chip stays a white ring badge so it reads
    // as the current value against the row's stone-100 hover.
    return (
      <div
        className={`relative flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-sm text-stone-700 hover:bg-stone-100 ${className}`}
      >
        <span aria-hidden>{t("language")}</span>
        <span
          aria-hidden
          className="inline-flex items-center gap-0.5 rounded-md bg-white px-2 py-0.5 text-xs font-medium text-stone-600 ring-1 ring-stone-200"
        >
          {LOCALE_SHORT_LABELS[locale as keyof typeof LOCALE_SHORT_LABELS] ?? locale}
          <span className="text-[10px] text-stone-400">▾</span>
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
      </div>
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
