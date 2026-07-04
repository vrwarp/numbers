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

/**
 * The single string printed in the PDF's "For Ministry / Event" column.
 * Em dash rather than "/" because category names already contain slashes
 * ("340 Nursery / Toddler Program").
 */
export function formatMinistryEvent(ministry: string, event: string): string {
  const e = event.trim();
  return e ? `${ministry} — ${e}` : ministry;
}
