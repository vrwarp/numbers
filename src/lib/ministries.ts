/**
 * Budget categories for the "Ministry / Fund" dropdown and PDF form, straight
 * from the church's chart of accounts (number + name). Kept in a
 * dependency-free module so both server and client components can import it.
 *
 * The list is a convenience, not a constraint: LineItem.ministry stays free
 * text so the UI can offer an "Other…" escape hatch and old data keeps
 * rendering. The server only ever requires ministry to be non-empty.
 */
export const MINISTRY_GROUPS = [
  {
    label: "Administration & General Expense",
    options: [
      "210 Sunday Guest Speaker Honorarium",
      "212 Dues and Registration",
      "215 Gifts and Appreciation",
      "237 Office Supplies",
      "239 Office Equipment",
      "245 Drinking Water",
      "250 Luncheon Catering",
      "253 Kitchen Equipment & Supplies",
      "255 Holy Communion Supplies",
      "260 Copier & Reproduction",
      "265 Janitorial & Cleaning",
      "266 Gardening",
      "270 Security System",
      "283 Media, Audio, Visual System",
    ],
  },
  {
    label: "Education",
    options: [
      "300 Children Sunday School",
      "311 CE Classes - English Adult",
      "315 Children Friday Night Program",
      "320 VBS",
      "330 Misc. Children Program (Summer Program, etc.)",
      "340 Nursery / Toddler Program",
      "355 Library - Mandarin",
      "356 Library - English",
      "371 Leadership Development - English",
      "375 Literature Subscription",
    ],
  },
  {
    label: "Fellowships & Ministries",
    options: [
      "400 Churchwide Celebration/Outreach",
      "410 Choir/Worship Team - Mandarin",
      "425 Caring - Mandarin",
      "431 English Small Group - Family & Int. Gen.",
      "432 English Evangelical/Caring Outreach",
      "433 English Neighborhood & Community Ministry",
      "434 English MERGE",
      "435 English TRANSPARENT",
      "439 Caring - English",
      "440 Youth Fellowship (aka Footprint)",
      "450 Joshua Fellowship - Mandarin",
    ],
  },
  {
    label: "Retreats Expense",
    options: ["470 Summer Retreat", "471 Youth Retreat", "481 TRANSPARENT Retreat"],
  },
  {
    label: "Property Rental & Maintenance",
    options: [
      "525 Landscape Improvement",
      "530 Building Maintenance, Repair & Misc.",
      "535 Property Rental",
      "540 Building Renovation",
    ],
  },
  {
    label: "Missions",
    options: [
      "811 Short Term Mission Trip 2",
      "813 Short Term Mission Trip 4",
      "850 Mission Org & Missionary Support, Regular",
    ],
  },
] as const;

/** Flat list of every budget category, for membership checks. */
export const MINISTRIES = MINISTRY_GROUPS.flatMap((g) => g.options) as readonly string[];

/** False for free-text ("Other…") values and legacy data predating the list. */
export function isKnownMinistry(value: string): boolean {
  return MINISTRIES.includes(value);
}

// --- Split code + name (the configurable catalog) ---------------------------
// A budget category is an account `code` (3 digits) + an editable `name`. The
// value stored on a line item and printed on the form is the two composed:
// "245 Drinking Water". The catalog (the `Ministry` table) is the source for
// the dropdown, descriptions, and AI-suggestion validation; this module holds
// the pure, dependency-free helpers both client and server share, plus the
// built-in defaults used to seed the catalog and as the fallback while it is
// empty.

/** A catalog entry: the account code, its label, its group, and optional
 *  treasurer-authored guidance. Composed as `${code} ${name}` when stored. */
export interface MinistryEntry {
  code: string;
  name: string;
  group: string;
  description: string;
  active: boolean;
  sortOrder: number;
}

/** The reserved code for uncategorized ("Other…") free text. It is never
 *  stored in the catalog or on a composed value — free text prints as its own
 *  text alone — so 999 never reaches the official form. */
export const RESERVED_UNCATEGORIZED_CODE = "999";

/** Catalog codes are exactly three digits and never the reserved 999. */
export function isValidMinistryCode(code: string): boolean {
  return /^\d{3}$/.test(code) && code !== RESERVED_UNCATEGORIZED_CODE;
}

/** The single value stored on a line item and printed on the form: the account
 *  code followed by the name ("245 Drinking Water"). Free text (no code) is
 *  returned unchanged, so nothing extra is ever printed. */
export function composeMinistry(code: string, name: string): string {
  const c = code.trim();
  const n = name.trim();
  return c ? `${c} ${n}` : n;
}

/** The leading 3-digit account code of a composed value, or null for free text. */
export function parseMinistryCode(value: string): string | null {
  return value.match(/^(\d{3})\s+/)?.[1] ?? null;
}

/** Group active entries into the {label, options} shape the dropdown renders,
 *  preserving each group's first-appearance order and the entries' order. */
export function ministryGroupsFromEntries(
  entries: readonly MinistryEntry[]
): { label: string; options: string[] }[] {
  const order: string[] = [];
  const byGroup = new Map<string, string[]>();
  for (const e of entries) {
    if (!e.active) continue;
    if (!byGroup.has(e.group)) {
      byGroup.set(e.group, []);
      order.push(e.group);
    }
    byGroup.get(e.group)!.push(composeMinistry(e.code, e.name));
  }
  return order.map((label) => ({ label, options: byGroup.get(label)! }));
}

/** The built-in list as catalog entries — the seed the treasurer's editor
 *  starts from and the fallback the loader serves while the table is empty.
 *  Every default option carries a 3-digit code, so the parse always succeeds. */
export const DEFAULT_MINISTRY_ENTRIES: MinistryEntry[] = MINISTRY_GROUPS.flatMap((g, gi) =>
  g.options.map((opt, oi) => {
    const m = opt.match(/^(\d{3})\s+(.*)$/);
    return {
      code: m ? m[1] : "",
      name: m ? m[2] : opt,
      group: g.label,
      description: "",
      active: true,
      sortOrder: gi * 100 + oi,
    };
  })
);

/**
 * The single string printed in the PDF's "For Ministry / Event" column.
 * Em dash rather than "/" because category names already contain slashes
 * ("340 Nursery / Toddler Program").
 */
export function formatMinistryEvent(ministry: string, event: string): string {
  const e = event.trim();
  return e ? `${ministry} — ${e}` : ministry;
}

/**
 * The most frequent non-empty (ministry, event) pair among a claim's active
 * rows — what single-ministry mode adopts when the user switches a claim from
 * "multiple" to "one ministry". Excluded rows don't vote; ties go to the pair
 * seen first in row order. Both strings empty when no row has a ministry.
 * Kept here (dependency-free) because both the claim PATCH route and the
 * review UI's mode-switch dialog must compute the same answer.
 */
export function mostCommonMinistryEvent(
  rows: readonly { ministry: string; event: string; isExcluded?: boolean }[]
): { ministry: string; event: string } {
  const counts = new Map<string, { ministry: string; event: string; count: number }>();
  for (const row of rows) {
    if (row.isExcluded || !row.ministry) continue;
    const key = JSON.stringify([row.ministry, row.event]);
    const entry = counts.get(key) ?? { ministry: row.ministry, event: row.event, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  let best = { ministry: "", event: "", count: 0 };
  for (const entry of counts.values()) {
    if (entry.count > best.count) best = entry;
  }
  return { ministry: best.ministry, event: best.event };
}
