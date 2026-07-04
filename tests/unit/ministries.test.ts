import { describe, expect, it } from "vitest";
import {
  MINISTRIES,
  MINISTRY_GROUPS,
  formatMinistryEvent,
  isKnownMinistry,
  mostCommonMinistryEvent,
} from "@/lib/ministries";

describe("ministry budget list", () => {
  it("flattens every group without duplicates", () => {
    expect(MINISTRIES.length).toBe(MINISTRY_GROUPS.reduce((n, g) => n + g.options.length, 0));
    expect(new Set(MINISTRIES).size).toBe(MINISTRIES.length);
  });

  it("every entry starts with its budget number", () => {
    for (const m of MINISTRIES) expect(m).toMatch(/^\d{3} \S/);
  });

  it("isKnownMinistry accepts list entries and rejects custom/legacy values", () => {
    expect(isKnownMinistry("237 Office Supplies")).toBe(true);
    expect(isKnownMinistry("440 Youth Fellowship (aka Footprint)")).toBe(true);
    expect(isKnownMinistry("General Fund")).toBe(false); // legacy pre-list value
    expect(isKnownMinistry("Pastor Appreciation")).toBe(false);
    expect(isKnownMinistry("")).toBe(false);
  });
});

describe("formatMinistryEvent", () => {
  it("returns the ministry alone when the event is blank", () => {
    expect(formatMinistryEvent("237 Office Supplies", "")).toBe("237 Office Supplies");
    expect(formatMinistryEvent("237 Office Supplies", "   ")).toBe("237 Office Supplies");
  });

  it("joins ministry and event with an em dash", () => {
    expect(formatMinistryEvent("470 Summer Retreat", "Deposit")).toBe("470 Summer Retreat — Deposit");
    expect(formatMinistryEvent("Other Ministry", " Christmas Party ")).toBe(
      "Other Ministry — Christmas Party"
    );
  });
});

describe("mostCommonMinistryEvent", () => {
  const row = (ministry: string, event = "", isExcluded = false) => ({ ministry, event, isExcluded });

  it("picks the most frequent (ministry, event) pair", () => {
    expect(
      mostCommonMinistryEvent([row("237 Office Supplies"), row("320 VBS"), row("320 VBS")])
    ).toEqual({ ministry: "320 VBS", event: "" });
  });

  it("treats the same ministry with different events as different pairs", () => {
    expect(
      mostCommonMinistryEvent([
        row("470 Summer Retreat", "Deposit"),
        row("470 Summer Retreat", "Deposit"),
        row("470 Summer Retreat", "Food"),
      ])
    ).toEqual({ ministry: "470 Summer Retreat", event: "Deposit" });
  });

  it("ignores excluded rows and rows without a ministry", () => {
    expect(
      mostCommonMinistryEvent([
        row(""),
        row("320 VBS", "", true),
        row("320 VBS", "", true),
        row("237 Office Supplies"),
      ])
    ).toEqual({ ministry: "237 Office Supplies", event: "" });
  });

  it("breaks ties in favor of the pair seen first", () => {
    expect(
      mostCommonMinistryEvent([row("320 VBS"), row("237 Office Supplies")])
    ).toEqual({ ministry: "320 VBS", event: "" });
  });

  it("returns empty strings when no active row has a ministry", () => {
    expect(mostCommonMinistryEvent([row(""), row("320 VBS", "", true)])).toEqual({
      ministry: "",
      event: "",
    });
    expect(mostCommonMinistryEvent([])).toEqual({ ministry: "", event: "" });
  });
});
