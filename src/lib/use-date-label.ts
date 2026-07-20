"use client";

import { useFormatter, useTimeZone, useTranslations } from "next-intl";
import { relativeDateLabel, relativeDayKey } from "./date-label";
import { DEFAULT_TIME_ZONE } from "./timezone";

// The date-format options callers pass through — a subset assignable to both
// Intl.DateTimeFormatOptions and next-intl's slightly narrower variant (which
// tightens fields like `calendar`/`timeZoneName` this app never sets).
type DateTimeOptions = {
  weekday?: "long" | "short" | "narrow";
  year?: "numeric" | "2-digit";
  month?: "numeric" | "2-digit" | "long" | "short" | "narrow";
  day?: "numeric" | "2-digit";
  hour?: "numeric" | "2-digit";
  minute?: "numeric" | "2-digit";
  second?: "numeric" | "2-digit";
  dateStyle?: "full" | "long" | "medium" | "short";
  timeStyle?: "full" | "long" | "medium" | "short";
};

const DEFAULT_OPTS: DateTimeOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Client-side "Today"/"Yesterday"/date formatter (see src/lib/date-label.ts).
 * Returns a function `label(date, opts?)` — pass the same next-intl date
 * options the site used before; they apply only when the date isn't today or
 * yesterday. Invalid/empty inputs yield "" so callers can render conditionally.
 *
 * A bare "YYYY-MM-DD" string (a receipt's transcribed purchaseDate) is a
 * calendar DATE, not an instant: it's compared to today's date in the app
 * time zone and formatted exactly as written (via a UTC-pinned render), so
 * it can never drift a day whatever zone the viewer or server is in.
 */
export function useDateLabel() {
  const format = useFormatter();
  const t = useTranslations("Common.date");
  const timeZone = useTimeZone() ?? DEFAULT_TIME_ZONE;
  return (date: Date | string | number, opts: DateTimeOptions = DEFAULT_OPTS) => {
    if (typeof date === "string" && DATE_ONLY.test(date)) {
      const utcMidnight = new Date(`${date}T00:00:00Z`);
      if (Number.isNaN(utcMidnight.getTime())) return "";
      const rel = relativeDayKey(date, new Date(), timeZone);
      if (rel === "today") return t("today");
      if (rel === "yesterday") return t("yesterday");
      return format.dateTime(utcMidnight, { ...opts, timeZone: "UTC" });
    }
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return "";
    return relativeDateLabel(
      d,
      new Date(),
      timeZone,
      { today: t("today"), yesterday: t("yesterday") },
      (x) => format.dateTime(x, opts)
    );
  };
}
