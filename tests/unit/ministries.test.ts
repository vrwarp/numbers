import { describe, expect, it } from "vitest";
import {
  DEFAULT_MINISTRY_DESCRIPTIONS,
  DEFAULT_MINISTRY_ENTRIES,
  MINISTRIES,
  MINISTRY_GROUPS,
  composeMinistry,
  formatMinistryEvent,
  isKnownMinistry,
  isValidMinistryCode,
  ministryGroupsFromEntries,
  mostCommonMinistryEvent,
  parseMinistryCode,
  type MinistryEntry,
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

describe("split code + name", () => {
  it("composes a code and name, and leaves free text untouched", () => {
    expect(composeMinistry("245", "Drinking Water")).toBe("245 Drinking Water");
    expect(composeMinistry(" 245 ", " Drinking Water ")).toBe("245 Drinking Water");
    expect(composeMinistry("", "Pastor's book fund")).toBe("Pastor's book fund");
  });

  it("parses the 3-digit code off a composed value, null for free text", () => {
    expect(parseMinistryCode("245 Drinking Water")).toBe("245");
    expect(parseMinistryCode("340 Nursery / Toddler Program")).toBe("340");
    expect(parseMinistryCode("Worship night snacks")).toBeNull();
    expect(parseMinistryCode("")).toBeNull();
  });

  it("validates codes as 3 digits and rejects the reserved 999", () => {
    expect(isValidMinistryCode("245")).toBe(true);
    expect(isValidMinistryCode("999")).toBe(false); // reserved for uncategorized
    expect(isValidMinistryCode("24")).toBe(false);
    expect(isValidMinistryCode("2455")).toBe(false);
    expect(isValidMinistryCode("abc")).toBe(false);
    expect(isValidMinistryCode("")).toBe(false);
  });

  it("derives default entries that round-trip back to the built-in list", () => {
    expect(DEFAULT_MINISTRY_ENTRIES.length).toBe(MINISTRIES.length);
    for (const e of DEFAULT_MINISTRY_ENTRIES) {
      expect(isValidMinistryCode(e.code)).toBe(true);
      expect(MINISTRIES).toContain(composeMinistry(e.code, e.name));
    }
    // The regrouped composed options equal the original hard-coded groups.
    const regrouped = ministryGroupsFromEntries(DEFAULT_MINISTRY_ENTRIES);
    expect(regrouped).toEqual(MINISTRY_GROUPS.map((g) => ({ label: g.label, options: [...g.options] })));
  });

  it("every default entry carries guidance within the editor's 500-char cap", () => {
    for (const e of DEFAULT_MINISTRY_ENTRIES) {
      expect(e.description.length, `description for ${e.code} ${e.name}`).toBeGreaterThan(0);
      expect(e.description.length, `description for ${e.code} ${e.name}`).toBeLessThanOrEqual(500);
    }
    // No orphaned guidance: every described code exists in the default list.
    const codes = new Set(DEFAULT_MINISTRY_ENTRIES.map((e) => e.code));
    for (const code of Object.keys(DEFAULT_MINISTRY_DESCRIPTIONS)) {
      expect(codes.has(code), `description for unknown code ${code}`).toBe(true);
    }
  });

  it("ministryGroupsFromEntries drops archived rows and keeps group order", () => {
    const entries: MinistryEntry[] = [
      { code: "245", name: "Drinking Water", group: "Admin", description: "", active: true, sortOrder: 0 },
      { code: "270", name: "Security", group: "Admin", description: "", active: false, sortOrder: 1 },
      { code: "320", name: "VBS", group: "Education", description: "", active: true, sortOrder: 2 },
    ];
    expect(ministryGroupsFromEntries(entries)).toEqual([
      { label: "Admin", options: ["245 Drinking Water"] },
      { label: "Education", options: ["320 VBS"] },
    ]);
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
