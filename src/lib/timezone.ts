/**
 * Deployment display time zone. Every human-facing calendar date — "Today"/
 * "Yesterday" labels, the MM/DD/YYYY stamped on generated and approved PDFs,
 * the admin usage chart's day buckets — is computed in ONE configured IANA
 * zone (`TIME_ZONE`, admin-editable), never in the server's ambient zone
 * (UTC inside Docker) or the browser's. Default: America/Los_Angeles — the
 * church is in Hayward, CA.
 *
 * Isomorphic and dependency-free (client components import it); the config
 * READ lives in src/lib/config.ts (`appTimeZone()`, server-only via fs) and
 * reaches the client through next-intl's provider (`useTimeZone()`).
 */

export const DEFAULT_TIME_ZONE = "America/Los_Angeles";

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// One Intl.DateTimeFormat per zone — these are expensive to construct and the
// list views call zonedDayKey per row.
const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsIn(date: Date, timeZone: string): { year: string; month: string; day: string } {
  let fmt = partFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    partFormatters.set(timeZone, fmt);
  }
  const out = { year: "", month: "", day: "" };
  for (const p of fmt.formatToParts(date)) {
    if (p.type === "year" || p.type === "month" || p.type === "day") out[p.type] = p.value;
  }
  return out;
}

/** The calendar day `date` falls on in `timeZone`, as a "YYYY-MM-DD" key. */
export function zonedDayKey(date: Date, timeZone: string): string {
  const { year, month, day } = partsIn(date, timeZone);
  return `${year}-${month}-${day}`;
}

/** The calendar day before a "YYYY-MM-DD" key (pure date arithmetic — no
 *  zone/DST involvement, so a 23/25-hour day can't skip or repeat a key). */
export function previousDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}-${String(
    prev.getUTCDate()
  ).padStart(2, "0")}`;
}

/** MM/DD/YYYY in `timeZone` — the date format the official CFCC form carries
 *  (claim packet date line, approval marks). */
export function formatDateMMDDYYYY(date: Date, timeZone: string): string {
  const { year, month, day } = partsIn(date, timeZone);
  return `${month}/${day}/${year}`;
}

/** The calendar year `date` falls in in `timeZone` (search-index year keys). */
export function zonedYear(date: Date, timeZone: string): number {
  return Number(partsIn(date, timeZone).year);
}

/** MM/YYYY in `timeZone` — the month label inside claim embedding composites. */
export function formatMonthMMYYYY(date: Date, timeZone: string): string {
  const { year, month } = partsIn(date, timeZone);
  return `${month}/${year}`;
}
