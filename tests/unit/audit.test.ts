import { describe, expect, it } from "vitest";
import { computeLineItemChanges } from "@/lib/audit";

const item = {
  description: "Sales Tax",
  quantity: 1,
  amountCents: 864,
  ministry: "General Fund",
  isVerified: false,
  isExcluded: false,
};

describe("computeLineItemChanges", () => {
  it("captures only fields that actually change", () => {
    const changes = computeLineItemChanges(item, { amountCents: 725, ministry: "General Fund" });
    expect(changes).toEqual({ amountCents: { from: 864, to: 725 } });
  });

  it("tracks every reviewable field", () => {
    const changes = computeLineItemChanges(item, {
      description: "Sales Tax (adjusted)",
      quantity: 2,
      amountCents: 999,
      ministry: "Facilities",
      isVerified: true,
      isExcluded: true,
    });
    expect(Object.keys(changes).sort()).toEqual([
      "amountCents",
      "description",
      "isExcluded",
      "isVerified",
      "ministry",
      "quantity",
    ]);
    expect(changes.description).toEqual({ from: "Sales Tax", to: "Sales Tax (adjusted)" });
  });

  it("returns an empty set for a no-op patch", () => {
    expect(computeLineItemChanges(item, {})).toEqual({});
    expect(computeLineItemChanges(item, { amountCents: 864 })).toEqual({});
  });

  it("ignores undefined patch values", () => {
    expect(computeLineItemChanges(item, { description: undefined })).toEqual({});
  });
});
