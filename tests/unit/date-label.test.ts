import { describe, expect, it } from "vitest";
import { relativeDay, relativeDateLabel } from "@/lib/date-label";
import { claimSubtitle } from "@/lib/claim-subtitle";

/**
 * Human-facing relative date labels (src/lib/date-label.ts): "today"/"yesterday"
 * for the two most recent calendar days in the local frame, otherwise the
 * supplied formatter runs. Plus the claim-row subtitle fallback that joins the
 * distinct events a claim spans instead of a bare item count.
 */

describe("relativeDay", () => {
  const now = new Date(2026, 6, 17, 9, 30); // Jul 17 2026, local

  it("flags the same calendar day as today, regardless of time", () => {
    expect(relativeDay(new Date(2026, 6, 17, 0, 0), now)).toBe("today");
    expect(relativeDay(new Date(2026, 6, 17, 23, 59), now)).toBe("today");
  });

  it("flags the previous calendar day as yesterday", () => {
    expect(relativeDay(new Date(2026, 6, 16, 12, 0), now)).toBe("yesterday");
  });

  it("returns null for older or future dates", () => {
    expect(relativeDay(new Date(2026, 6, 15, 12, 0), now)).toBeNull();
    expect(relativeDay(new Date(2026, 6, 18, 12, 0), now)).toBeNull();
    expect(relativeDay(new Date(2025, 6, 17, 12, 0), now)).toBeNull();
  });

  it("crosses a month boundary correctly (1st vs previous month's last day)", () => {
    const firstOfMonth = new Date(2026, 7, 1, 8, 0); // Aug 1
    expect(relativeDay(new Date(2026, 6, 31, 20, 0), firstOfMonth)).toBe("yesterday"); // Jul 31
    expect(relativeDay(new Date(2026, 7, 1, 1, 0), firstOfMonth)).toBe("today");
  });
});

describe("relativeDateLabel", () => {
  const now = new Date(2026, 6, 17, 9, 30);
  const labels = { today: "Today", yesterday: "Yesterday" };
  const fmt = (d: Date) => `#${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

  it("uses the words for today/yesterday and the formatter otherwise", () => {
    expect(relativeDateLabel(new Date(2026, 6, 17, 15, 0), now, labels, fmt)).toBe("Today");
    expect(relativeDateLabel(new Date(2026, 6, 16, 15, 0), now, labels, fmt)).toBe("Yesterday");
    expect(relativeDateLabel(new Date(2026, 6, 3, 15, 0), now, labels, fmt)).toBe("#2026-7-3");
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
