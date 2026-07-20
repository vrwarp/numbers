import { describe, expect, it } from "vitest";
import { relativeDay, relativeDayKey, relativeDateLabel } from "@/lib/date-label";
import { claimSubtitle } from "@/lib/claim-subtitle";

/**
 * Human-facing relative date labels (src/lib/date-label.ts): "today"/"yesterday"
 * for the two most recent calendar days in the app time zone (TIME_ZONE),
 * otherwise the supplied formatter runs. Instants are fixed UTC epochs so the
 * suite passes in any host zone. Plus the claim-row subtitle fallback that
 * joins the distinct events a claim spans instead of a bare item count.
 */

const LA = "America/Los_Angeles";

describe("relativeDay", () => {
  // Jul 17 2026 09:30 PDT (UTC-7) = 16:30Z
  const now = new Date("2026-07-17T16:30:00Z");

  it("flags the same calendar day as today, regardless of time", () => {
    expect(relativeDay(new Date("2026-07-17T07:00:00Z"), now, LA)).toBe("today"); // 00:00 PDT
    expect(relativeDay(new Date("2026-07-18T06:59:00Z"), now, LA)).toBe("today"); // 23:59 PDT
  });

  it("flags the previous calendar day as yesterday", () => {
    expect(relativeDay(new Date("2026-07-16T19:00:00Z"), now, LA)).toBe("yesterday");
  });

  it("returns null for older or future dates", () => {
    expect(relativeDay(new Date("2026-07-15T19:00:00Z"), now, LA)).toBeNull();
    expect(relativeDay(new Date("2026-07-18T19:00:00Z"), now, LA)).toBeNull();
    expect(relativeDay(new Date("2025-07-17T19:00:00Z"), now, LA)).toBeNull();
  });

  it("decides the day in the APP zone, not UTC", () => {
    // Jul 17 22:00 PDT = Jul 18 05:00Z — a UTC comparison would say "yesterday".
    const eveningPT = new Date("2026-07-18T05:00:00Z");
    expect(relativeDay(eveningPT, now, LA)).toBe("today");
    expect(relativeDay(eveningPT, now, "UTC")).toBeNull(); // now is the 17th in UTC too
  });

  it("crosses a month boundary correctly (1st vs previous month's last day)", () => {
    const firstOfMonth = new Date("2026-08-01T15:00:00Z"); // Aug 1 08:00 PDT
    expect(relativeDay(new Date("2026-08-01T03:00:00Z"), firstOfMonth, LA)).toBe("yesterday"); // Jul 31 20:00 PDT
    expect(relativeDay(new Date("2026-08-01T08:00:00Z"), firstOfMonth, LA)).toBe("today"); // Aug 1 01:00 PDT
  });

  it("crosses a year boundary correctly", () => {
    const newYear = new Date("2027-01-01T17:00:00Z"); // Jan 1 09:00 PST
    expect(relativeDay(new Date("2027-01-01T04:00:00Z"), newYear, LA)).toBe("yesterday"); // Dec 31 20:00 PST
  });
});

describe("relativeDayKey (date-only strings, e.g. purchaseDate)", () => {
  const now = new Date("2026-07-17T16:30:00Z"); // Jul 17 09:30 PDT

  it("compares the transcribed calendar date to the app-zone today", () => {
    expect(relativeDayKey("2026-07-17", now, LA)).toBe("today");
    expect(relativeDayKey("2026-07-16", now, LA)).toBe("yesterday");
    expect(relativeDayKey("2026-07-15", now, LA)).toBeNull();
  });

  it("late-evening PT 'now' still matches the PT date, not the UTC one", () => {
    const latePT = new Date("2026-07-18T05:00:00Z"); // Jul 17 22:00 PDT
    expect(relativeDayKey("2026-07-17", latePT, LA)).toBe("today");
    expect(relativeDayKey("2026-07-18", latePT, LA)).toBeNull(); // UTC's day is not today here
  });
});

describe("relativeDateLabel", () => {
  const now = new Date("2026-07-17T16:30:00Z");
  const labels = { today: "Today", yesterday: "Yesterday" };
  const fmt = (d: Date) => `#${d.toISOString().slice(0, 10)}`;

  it("uses the words for today/yesterday and the formatter otherwise", () => {
    expect(relativeDateLabel(new Date("2026-07-17T22:00:00Z"), now, LA, labels, fmt)).toBe("Today");
    expect(relativeDateLabel(new Date("2026-07-16T22:00:00Z"), now, LA, labels, fmt)).toBe("Yesterday");
    expect(relativeDateLabel(new Date("2026-07-03T22:00:00Z"), now, LA, labels, fmt)).toBe("#2026-07-03");
  });
});

describe("claimSubtitle", () => {
  const fallback = (n: number) => `${n} items`;

  it("prefers the authored claim description", () => {
    expect(
      claimSubtitle({ claimDescription: "Retreat snacks", rows: [{ event: "Youth" }] }, fallback)
    ).toBe("Retreat snacks");
  });

  it("joins the distinct events when there is no description", () => {
    expect(
      claimSubtitle(
        {
          claimDescription: "",
          rows: [{ event: "4th of July" }, { event: "Christmas" }, { event: "4th of July" }],
        },
        fallback
      )
    ).toBe("4th of July, Christmas");
  });

  it("shows a single event once", () => {
    expect(
      claimSubtitle(
        { claimDescription: "", rows: [{ event: "Easter" }, { event: "Easter" }] },
        fallback
      )
    ).toBe("Easter");
  });

  it("falls back to the item count only when no row carries an event", () => {
    expect(
      claimSubtitle({ claimDescription: "", rows: [{ event: "" }, { event: "  " }] }, fallback)
    ).toBe("2 items");
  });
});
