import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIME_ZONE,
  formatDateMMDDYYYY,
  isValidTimeZone,
  previousDayKey,
  zonedDayKey,
} from "@/lib/timezone";

// The one place calendar-day math happens (src/lib/timezone.ts). Instants are
// fixed UTC epochs so results are host-zone independent.
describe("timezone helpers", () => {
  it("defaults to Hayward, CA's zone", () => {
    expect(DEFAULT_TIME_ZONE).toBe("America/Los_Angeles");
  });

  it("isValidTimeZone accepts IANA names and rejects junk", () => {
    expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Not/A_Zone")).toBe(false);
    // Validity is "whatever the runtime's Intl accepts" — legacy aliases like
    // "PST" pass on Node/ICU; that's fine, they still format correctly.
  });

  it("zonedDayKey renders the calendar day of the given zone", () => {
    const t = new Date("2026-07-18T05:00:00Z"); // Jul 17 22:00 PDT
    expect(zonedDayKey(t, "America/Los_Angeles")).toBe("2026-07-17");
    expect(zonedDayKey(t, "UTC")).toBe("2026-07-18");
    expect(zonedDayKey(t, "Asia/Taipei")).toBe("2026-07-18"); // 13:00 +08
  });

  it("previousDayKey is pure date arithmetic across month/year edges", () => {
    expect(previousDayKey("2026-07-17")).toBe("2026-07-16");
    expect(previousDayKey("2026-08-01")).toBe("2026-07-31");
    expect(previousDayKey("2026-01-01")).toBe("2025-12-31");
    expect(previousDayKey("2028-03-01")).toBe("2028-02-29"); // leap year
  });

  it("formatDateMMDDYYYY stamps the zone's calendar day (CFCC form format)", () => {
    const t = new Date("2026-01-01T04:00:00Z"); // Dec 31 20:00 PST
    expect(formatDateMMDDYYYY(t, "America/Los_Angeles")).toBe("12/31/2025");
    expect(formatDateMMDDYYYY(t, "UTC")).toBe("01/01/2026");
  });

  it("handles DST transition days without skipping or doubling", () => {
    // US spring-forward 2026: Mar 8. 09:59Z is 01:59 PST; 11:00Z is 04:00 PDT.
    expect(zonedDayKey(new Date("2026-03-08T09:59:00Z"), "America/Los_Angeles")).toBe("2026-03-08");
    expect(zonedDayKey(new Date("2026-03-08T11:00:00Z"), "America/Los_Angeles")).toBe("2026-03-08");
    expect(previousDayKey("2026-03-09")).toBe("2026-03-08");
  });
});
