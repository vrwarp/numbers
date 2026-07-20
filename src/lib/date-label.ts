/**
 * Human-facing date labels: "Today"/"Yesterday" for the two most recent
 * calendar days, otherwise a normally-formatted date. Used everywhere a date
 * is shown to a person (claim/receipt lists, approval & finance rows, device
 * and member metadata) so recent activity reads at a glance.
 *
 * Pure + framework-free so it's unit-testable and usable from both client
 * (useDateLabel) and server (getFormatter) contexts. The "today" decision is
 * made in the SAME zone the caller formats in — the deployment's configured
 * TIME_ZONE (src/lib/timezone.ts), which next-intl carries as its global
 * timeZone — so browser, server render and PDF stamps all agree on which
 * calendar day it is, wherever the machine doing the rendering sits.
 *
 * Precise signature / audit timestamps (the e-sign chain of custody, the
 * /v/ verification view, the admin audit log, the certificate PDF) deliberately
 * keep their exact date+time and do NOT use this.
 */

import { previousDayKey, zonedDayKey } from "./timezone";

export type RelativeDay = "today" | "yesterday" | null;

/** "today" / "yesterday" for a "YYYY-MM-DD" day key relative to `now`'s
 *  calendar day in `timeZone`, else null. The key form serves date-only
 *  strings (a receipt's transcribed purchaseDate) without inventing a
 *  midnight instant for them. */
export function relativeDayKey(dayKey: string, now: Date, timeZone: string): RelativeDay {
  const today = zonedDayKey(now, timeZone);
  if (dayKey === today) return "today";
  if (dayKey === previousDayKey(today)) return "yesterday";
  return null;
}

/** "today" / "yesterday" relative to `now` in `timeZone` calendar days, else null. */
export function relativeDay(date: Date, now: Date, timeZone: string): RelativeDay {
  return relativeDayKey(zonedDayKey(date, timeZone), now, timeZone);
}

/**
 * The label for `date`: the translated "Today"/"Yesterday" word when it falls
 * on one of those days, otherwise `formatDate(date)`. Decoupled from next-intl
 * so the same logic serves the client hook and server callers — each supplies
 * its own translated words and date formatter.
 */
export function relativeDateLabel(
  date: Date,
  now: Date,
  timeZone: string,
  labels: { today: string; yesterday: string },
  formatDate: (d: Date) => string
): string {
  const rel = relativeDay(date, now, timeZone);
  if (rel === "today") return labels.today;
  if (rel === "yesterday") return labels.yesterday;
  return formatDate(date);
}
