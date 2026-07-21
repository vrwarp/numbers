import { describe, expect, it } from "vitest";
import { threeWayMerge } from "@/lib/catalog-drafts";

/**
 * The field-level 3-way merge that keeps a stale catalog-edit draft from
 * silently clobbering an intervening change (docs/MCP_DESIGN.md). Pure — no DB.
 */

describe("threeWayMerge", () => {
  it("applies a proposed change when nobody else touched the field", () => {
    const r = threeWayMerge("ministry", "update", { name: "A" }, { name: "A" }, { name: "B" });
    expect(r).toEqual({ targetGone: false, conflicts: [], fields: { name: "B" } });
  });

  it("auto-merges: a field this draft ignores that someone else changed is left alone", () => {
    // Draft only touches name; group drifted. No conflict, and group isn't written
    // (the partial update preserves it).
    const r = threeWayMerge(
      "ministry",
      "update",
      { name: "A", group: "G" },
      { name: "A", group: "G2" },
      { name: "B" }
    );
    expect(r.conflicts).toEqual([]);
    expect(r.fields).toEqual({ name: "B" });
  });

  it("flags a conflict when both changed the same field to different values", () => {
    const r = threeWayMerge("ministry", "update", { name: "A" }, { name: "C" }, { name: "B" });
    expect(r.conflicts).toEqual(["name"]);
    expect(r.targetGone).toBe(false);
  });

  it("treats an already-applied change as a no-op (no conflict, no write)", () => {
    const r = threeWayMerge("ministry", "update", { name: "A" }, { name: "B" }, { name: "B" });
    expect(r.conflicts).toEqual([]);
    expect(r.fields).toEqual({});
  });

  it("reports targetGone when the row no longer exists", () => {
    const r = threeWayMerge("ministry", "update", { name: "A" }, null, { name: "B" });
    expect(r.targetGone).toBe(true);
  });

  it("passes proposed straight through for create (no ancestor)", () => {
    const r = threeWayMerge("ministry", "create", {}, null, { code: "512", name: "X" });
    expect(r).toEqual({ targetGone: false, conflicts: [], fields: { code: "512", name: "X" } });
  });

  it("archive/delete carry no field merge (existence is what matters)", () => {
    expect(threeWayMerge("position", "archive", { name: "A" }, { name: "A" }, {})).toEqual({
      targetGone: false,
      conflicts: [],
      fields: {},
    });
    expect(threeWayMerge("position", "delete", { name: "A" }, null, {}).targetGone).toBe(true);
  });

  it("null and empty string are the same 'no value' for text fields", () => {
    const r = threeWayMerge(
      "position",
      "update",
      { nameZhHans: null },
      { nameZhHans: null },
      { nameZhHans: "宣教协调员" }
    );
    expect(r.conflicts).toEqual([]);
    expect(r.fields).toEqual({ nameZhHans: "宣教协调员" });
  });

  it("set-merges team codes: keeps a concurrently-added code while adding its own", () => {
    // base [420], someone else added 610, draft adds 512.
    const r = threeWayMerge("team", "update", { codes: ["420"] }, { codes: ["420", "610"] }, { codes: ["420", "512"] });
    expect(r.conflicts).toEqual([]);
    expect(r.fields.codes).toEqual(["420", "512", "610"]);
  });

  it("set-merges team codes: applies a removal while preserving a concurrent add", () => {
    // base [420,610], someone else added 700, draft removes 610.
    const r = threeWayMerge(
      "team",
      "update",
      { codes: ["420", "610"] },
      { codes: ["420", "610", "700"] },
      { codes: ["420"] }
    );
    expect(r.fields.codes).toEqual(["420", "700"]);
  });
});
