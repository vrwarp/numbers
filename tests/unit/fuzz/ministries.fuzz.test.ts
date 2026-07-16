import { describe, expect } from "vitest";
import {
  composeMinistry,
  parseMinistryCode,
  isValidMinistryCode,
  ministryGroupsFromEntries,
  mostCommonMinistryEvent,
  formatMinistryEvent,
  DEFAULT_MINISTRY_ENTRIES,
  RESERVED_UNCATEGORIZED_CODE,
  type MinistryEntry,
} from "@/lib/ministries";
import { fuzz, Rng } from "./prng";

function randomEntry(rng: Rng, i: number): MinistryEntry {
  return {
    code: rng.bool(0.8) ? String(rng.int(100, 998)) : "",
    name: rng.unicodeString(12) || `Name ${i}`,
    group: `Group ${rng.int(0, 3)}`,
    description: rng.asciiString(20),
    active: rng.bool(0.8),
    sortOrder: i,
  };
}

/**
 * Ministry values are the join key between line items, the catalog and the
 * printed form — compose/parse must stay inverse operations for any catalog
 * content an admin can type.
 */
describe("ministries fuzz", () => {
  fuzz("compose then parse recovers the code for valid 3-digit codes", { iters: 400 }, (rng) => {
    const code = String(rng.int(0, 999)).padStart(3, "0");
    const name = rng.unicodeString(16).trim() || "x";
    const composed = composeMinistry(code, name);
    expect(parseMinistryCode(composed)).toBe(code);
  });

  fuzz("free text (no code) composes to itself and parses to null", { iters: 300 }, (rng) => {
    // Free text that doesn't accidentally start with a 3-digit prefix.
    const name = `x${rng.unicodeString(12)}`.trim();
    const composed = composeMinistry("", name);
    expect(composed).toBe(name);
    expect(parseMinistryCode(composed)).toBe(name.match(/^(\d{3})\s+/) ? name.slice(0, 3) : null);
  });

  fuzz("isValidMinistryCode accepts exactly 3-digit non-reserved codes", { iters: 300 }, (rng) => {
    const n = rng.int(0, 9999);
    const s = String(n);
    const expected = s.length === 3 && s !== RESERVED_UNCATEGORIZED_CODE;
    expect(isValidMinistryCode(s)).toBe(expected);
    expect(isValidMinistryCode(` ${s}`)).toBe(false);
  });

  fuzz("groups from entries: only active entries, group order preserved", { iters: 300 }, (rng) => {
    const entries = rng.array(rng.int(0, 25), (r, i) => randomEntry(r, i));
    const groups = ministryGroupsFromEntries(entries);
    const active = entries.filter((e) => e.active);
    // Every active entry appears exactly once across groups.
    const allOptions = groups.flatMap((g) => g.options);
    expect(allOptions.length).toBe(active.length);
    // Group labels appear in first-appearance order of active entries.
    const expectedOrder: string[] = [];
    for (const e of active) if (!expectedOrder.includes(e.group)) expectedOrder.push(e.group);
    expect(groups.map((g) => g.label)).toEqual(expectedOrder);
    // No empty groups.
    for (const g of groups) expect(g.options.length).toBeGreaterThan(0);
  });

  fuzz("mostCommonMinistryEvent returns a maximal, existing pair", { iters: 400 }, (rng) => {
    const pool = rng.array(rng.int(1, 5), (r, i) => ({
      ministry: r.bool(0.85) ? `M${i}` : "",
      event: r.bool(0.5) ? `E${r.int(0, 2)}` : "",
    }));
    const rows = rng.array(rng.int(0, 30), (r) => ({
      ...r.pick(pool),
      isExcluded: r.bool(0.25),
    }));
    const winner = mostCommonMinistryEvent(rows);
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.isExcluded || !row.ministry) continue;
      const k = JSON.stringify([row.ministry, row.event]);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    if (counts.size === 0) {
      expect(winner).toEqual({ ministry: "", event: "" });
    } else {
      const winnerCount = counts.get(JSON.stringify([winner.ministry, winner.event]));
      expect(winnerCount).toBeDefined();
      expect(Math.max(...counts.values())).toBe(winnerCount);
    }
  });

  fuzz("excluded rows never influence the winner", { iters: 300 }, (rng) => {
    const rows = rng.array(rng.int(0, 20), (r) => ({
      ministry: r.bool(0.8) ? `M${r.int(0, 3)}` : "",
      event: "",
      isExcluded: r.bool(0.3),
    }));
    const withoutExcluded = rows.filter((r) => !r.isExcluded);
    expect(mostCommonMinistryEvent(rows)).toEqual(mostCommonMinistryEvent(withoutExcluded));
  });

  fuzz("formatMinistryEvent embeds both parts; blank event prints ministry alone", { iters: 300 }, (rng) => {
    const ministry = rng.unicodeString(10) || "M";
    const event = rng.bool() ? rng.unicodeString(10) : rng.pick(["", "  ", "\t"]);
    const out = formatMinistryEvent(ministry, event);
    if (event.trim()) {
      expect(out).toBe(`${ministry} — ${event.trim()}`);
    } else {
      expect(out).toBe(ministry);
    }
  });

  fuzz("default catalog entries all carry valid, parseable codes", { iters: 1 }, () => {
    for (const e of DEFAULT_MINISTRY_ENTRIES) {
      expect(isValidMinistryCode(e.code)).toBe(true);
      expect(parseMinistryCode(composeMinistry(e.code, e.name))).toBe(e.code);
    }
  });
});
