"use client";

import { useFormatter, useTranslations } from "next-intl";
import { relativeDateLabel } from "./date-label";

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

/**
 * Client-side "Today"/"Yesterday"/date formatter (see src/lib/date-label.ts).
 * Returns a function `label(date, opts?)` — pass the same next-intl date
 * options the site used before; they apply only when the date isn't today or
 * yesterday. Invalid/empty inputs yield "" so callers can render conditionally.
 */
export function useDateLabel() {
  const format = useFormatter();
  const t = useTranslations("Common.date");
  return (date: Date | string | number, opts: DateTimeOptions = DEFAULT_OPTS) => {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return "";
    return relativeDateLabel(
      d,
      new Date(),
      { today: t("today"), yesterday: t("yesterday") },
      (x) => format.dateTime(x, opts)
    );
  };
}
