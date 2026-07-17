/**
 * Human-facing date labels: "Today"/"Yesterday" for the two most recent
 * calendar days, otherwise a normally-formatted date. Used everywhere a date
 * is shown to a person (claim/receipt lists, approval & finance rows, device
 * and member metadata) so recent activity reads at a glance.
 *
 * Pure + framework-free so it's unit-testable and usable from both client
 * (useDateLabel) and server (getFormatter) contexts. The "today" decision is
 * made in the SAME local frame the caller formats in — next-intl has no time
 * zone configured, so both a client's browser and the server compare local
 * calendar days, matching the date the label sits beside.
 *
 * Precise signature / audit timestamps (the e-sign chain of custody, the
 * /v/ verification view, the admin audit log, the certificate PDF) deliberately
 * keep their exact date+time and do NOT use this.
 */

export type RelativeDay = "today" | "yesterday" | null;

function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "today" / "yesterday" relative to `now` in local calendar days, else null. */
export function relativeDay(date: Date, now: Date): RelativeDay {
  if (sameCalendarDay(date, now)) return "today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameCalendarDay(date, yesterday)) return "yesterday";
  return null;
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
  labels: { today: string; yesterday: string },
  formatDate: (d: Date) => string
): string {
  const rel = relativeDay(date, now);
  if (rel === "today") return labels.today;
  if (rel === "yesterday") return labels.yesterday;
  return formatDate(date);
}
