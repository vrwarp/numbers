import { describe, expect, it } from "vitest";
import { computeLineItemChanges } from "@/lib/audit";

const item = {
  description: "Costco Wholesale 06/21 — paper towels",
  amountCents: 10210,
  ministry: "General Fund",
  event: "",
  isVerified: false,
  isExcluded: false,
};

describe("computeLineItemChanges", () => {
  it("captures only fields that actually change", () => {
    const changes = computeLineItemChanges(item, { amountCents: 9000, ministry: "General Fund" });
    expect(changes).toEqual({ amountCents: { from: 10210, to: 9000 } });
  });

  it("tracks every reviewable field", () => {
    const changes = computeLineItemChanges(item, {
      description: "Costco Wholesale 06/21 — paper towels (less personal items)",
      amountCents: 999,
      ministry: "Facilities",
      event: "Summer Retreat",
      isVerified: true,
      isExcluded: true,
    });
    expect(Object.keys(changes).sort()).toEqual([
      "amountCents",
      "description",
      "event",
      "isExcluded",
      "isVerified",
      "ministry",
    ]);
    expect(changes.event).toEqual({ from: "", to: "Summer Retreat" });
    expect(changes.ministry).toEqual({ from: "General Fund", to: "Facilities" });
  });

  it("returns an empty set for a no-op patch", () => {
    expect(computeLineItemChanges(item, {})).toEqual({});
    expect(computeLineItemChanges(item, { amountCents: 10210 })).toEqual({});
  });

  it("ignores undefined patch values", () => {
    expect(computeLineItemChanges(item, { description: undefined })).toEqual({});
  });
});
