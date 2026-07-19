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

/**
 * Default per-category guidance, keyed by account code. Fed to the AI-suggest
 * prompt (and pre-filled into the treasurer's editor) to disambiguate
 * look-alike categories; inferred from the church's 2019–2021 QuickBooks
 * transaction history. Plain data, never printed on the form or translated.
 * Codes absent from the transaction history carry a best-guess note inferred
 * from the category name and its neighbors.
 */
export const DEFAULT_MINISTRY_DESCRIPTIONS: Record<string, string> = {
  // Administration & General Expense
  "210":
    "Honoraria for guest speakers at worship services and special meetings: Sunday pulpit supply for the English or Chinese service (typically a flat per-Sunday check), plus occasional Friday/Saturday evangelistic or missionary speakers; the check sometimes goes to the speaker's organization instead. Speakers for classes, workshops, or retreats belong to the hosting program's category.",
  "212":
    "Registration fees and membership dues for conferences, conventions, and training events church workers attend (e.g. a church workers convention). Retreat registrations go under Retreats Expense instead.",
  "215":
    "Gifts and appreciation for staff and volunteers: Christmas/year-end gift cards for pastoral and office staff, ordination gifts, retiring-deacon appreciation. Funeral or bereavement flowers belong under Caring; food for church-wide celebrations under 400.",
  "237":
    "Consumable office supplies: printer paper, ink and toner, envelopes, stationery, stamps, small software licenses (e.g. Microsoft 365), key copies, annual fire-extinguisher service. Durable machines are 239 Office Equipment; the copier lease and per-copy billing are 260.",
  "239":
    "Durable office hardware: computers (e.g. replacing an office or secretary PC), printers, monitors, shredders, office furniture and similar equipment purchases. Consumables like paper and ink are 237 Office Supplies.",
  "245":
    "Bottled drinking-water delivery for the church building (5-gallon bottles / fountain service), typically a small monthly invoice from the water vendor.",
  "250":
    "Catering and food for church luncheons, receptions, and refreshments: Chinese New Year, Mother's Day and Father's Day lunches, farewell and ceremony receptions (including cakes), monthly congregational refreshments, choir lunches, lunches for volunteer work crews. Refreshments bought as supplies for a specific ministry's event usually follow that event's own category.",
  "253":
    "Kitchen consumables and equipment for the church kitchen: bulk warehouse (e.g. Costco) runs for paper goods, paper towels, rice, coffee, cookware and cleaning supplies, plus kitchen equipment service such as range-hood maintenance.",
  "255":
    "Communion elements and supplies for both English and Chinese services: bread, juice, cups, and communion ware such as trays and plates.",
  "260":
    "Copier lease and reproduction: the monthly copier lease invoice and per-copy/maintenance billing from the copier vendor. Printer ink and paper are 237 Office Supplies.",
  "265": "Contracted janitorial and cleaning service for the church buildings, usually a fixed monthly invoice.",
  "266":
    "Routine gardening and lawn-care service, billed per visit or monthly, plus small yard clean-up extras. Larger one-time landscape projects are 525 Landscape Improvement.",
  "270":
    "Security and alarm system: quarterly alarm-monitoring fees, alarm repairs and battery service, and city/county alarm permits.",
  "283":
    "Worship media and audio/visual: sound gear (microphones, mixers, drum parts, in-ear monitors), media-room hardware (storage drives, cables, batteries), piano tuning, projection and streaming equipment, video/music licensing (e.g. CVLI, CCLI), church website domain renewals, and printing of the church journal/publication.",
  // Education
  "300":
    "Sunday-morning children's ministry (e.g. \"The Rock\"): quarterly curriculum and teaching materials, snacks, children's books, graduation gifts, Easter kids' events, teacher appreciation, kids' class Zoom licenses, parent-workshop speaker honoraria, volunteer background checks. The Friday-night kids program is 315; one-off seasonal kids events are 330.",
  "311":
    "English adult Christian-education classes: teaching subscriptions (e.g. RightNow Media), study guides and class materials for the English congregation's adult classes.",
  "315":
    "The Friday-night children's program (e.g. \"Shining Stars\"): weekly curriculum, snacks, goodie bags, family fun nights, Trunk-or-Treat family outreach night, care packages, Christmas stockings. Sunday children's classes are 300; VBS is 320.",
  "320": "Vacation Bible School: VBS curriculum, decorations, crafts, snacks, and supplies for the annual VBS week.",
  "330":
    "One-off and seasonal children's events outside the weekly programs: Harvest Festival candy and materials for kids, holiday goodie-bag drop-offs, summer program supplies.",
  "340": "Sunday nursery / toddler care: paid hourly nursery workers during services, and nursery supplies.",
  "355":
    "Chinese-language books for the church library, including pastoral and preaching reference books that return to the library after use. Magazine and devotional subscriptions belong in 375.",
  "356":
    "English-language books for the church library, including pastors' and leaders' book orders.",
  "371":
    "Leadership training and development for the English congregation: leaders' retreats and workshops — refreshments, materials, training resources, and babysitting during leaders' retreats.",
  "375":
    "Annual subscriptions to Christian magazines and devotionals distributed to the congregation (e.g. mission-organization magazines, Daily Bread, Walk Thru The Bible). Library book purchases are 355/356.",
  // Fellowships & Ministries
  "400":
    "Church-wide celebrations and outreach spanning congregations: Chinese New Year celebration, ordination receptions, Harvest Festival, Thanksgiving feast, anniversary publications, baptism and baby-dedication supplies.",
  "410":
    "Mandarin choir/worship team: instruments and sound gear (e.g. in-ear monitors), sheet music, and music licensing for the Chinese congregation's worship.",
  "425":
    "Caring ministry for the Mandarin congregation: funeral and bereavement flowers, Mother's Day flowers and decorations, hospital visits, member care. English-side caring is 439.",
  "431":
    "English family & intergenerational small groups (e.g. \"Roots\"): study-book sets, group gatherings and event babysitting, baby-dedication receptions.",
  "432":
    "English congregation evangelistic and caring outreach: the recurring English Café / Crossing coffee-and-cake hospitality, Easter and Thanksgiving outreach, Christmas cookie outreach, Harvest Festival outreach, baptism gifts. One-off neighborhood or community events are 433.",
  "433":
    "English-led neighborhood and community ministry: community events serving the neighborhood, such as a BBQ at the partner elementary school. The recurring café hospitality and seasonal outreach events are 432.",
  "434":
    "MERGE, an English fellowship group: gatherings, food (e.g. dumpling night), and study-book sets.",
  "435":
    "TRANSPARENT, the English young-adult fellowship: gatherings and food, study-book sets, outreach BBQs, Zoom licenses, activity supplies (e.g. secret-santa shipping). Its dedicated retreat is 481.",
  "439":
    "Caring ministry for the English congregation: gift Bibles and care gift bags, flowers, care packages, meals and support for members in grief, illness, or need. Mandarin-side caring is 425.",
  "440":
    "Footprint(s), the youth fellowship: Friday-night food and snacks, counselor dinners and training, study books, program materials, care packages, senior send-off, seasonal outreach parties, volunteer background checks (e.g. Protect My Ministry). Youth retreats are 471.",
  "450":
    "Joshua Fellowship, a Mandarin-speaking fellowship group: gatherings, food, study materials, and speakers charged to its budget.",
  // Retreats Expense
  "470":
    "The church-wide summer retreat: venue deposits and balance payments (e.g. university campus), speaker honoraria plus their airfare and lodging, children's care workers, lifeguard, registration refunds, publicity and materials. Youth-specific retreats are 471; the young-adult TRANSPARENT retreat is 481.",
  "471":
    "Youth retreats and conferences (retreat aka \"Bigfoot\"): venue payments, speaker honoraria, bus rental, registration fees, and shared costs with partner churches (e.g. a winter youth conference).",
  "481":
    "The TRANSPARENT young-adult retreat: venue deposits and payments (camp / conference center), speaker honoraria, nursery care, food, and retreat supplies.",
  // Property Rental & Maintenance
  "525":
    "One-time landscape improvement projects such as paving or repaving the grounds, new plantings, and irrigation. Routine mowing and gardening service is 266; tree removal and yard repairs have historically been booked to 530.",
  "530":
    "Building repairs and upkeep: plumbing and drain-rooter work, toilet and faucet repairs, fence and parking-lot repairs, light-bulb replacement, A/C repair, tree removal, monthly pest-control service. Renovation projects are 540; janitorial service is 265.",
  "535":
    "Rent the church pays for space it uses: school facility rental for worship services (e.g. via Facilitron), portable/modular building lease, overflow parking-lot rental.",
  "540":
    "Capital renovation and construction on church buildings — contractor work that upgrades or remodels rather than repairs (repairs are 530).",
  // Missions
  "811":
    "A designated short-term mission trip (trip slot 2 — e.g. the Taiwan STM): team travel, trip materials, and donations to host churches or ministries (e.g. VBS materials and gifts for children at the destination).",
  "813":
    "A designated short-term mission trip (trip slot 4 — e.g. a pastor's mission trip): team travel, trip materials, and donations to the hosts.",
  "850":
    "Regular budgeted support to mission organizations and missionaries, usually semiannual checks to each organization. One-time or surplus-designated mission gifts and short-term trip costs are separate.",
};

/** The built-in list as catalog entries — the seed the treasurer's editor
 *  starts from and the fallback the loader serves while the table is empty.
 *  Every default option carries a 3-digit code, so the parse always succeeds. */
export const DEFAULT_MINISTRY_ENTRIES: MinistryEntry[] = MINISTRY_GROUPS.flatMap((g, gi) =>
  g.options.map((opt, oi) => {
    const m = opt.match(/^(\d{3})\s+(.*)$/);
    const code = m ? m[1] : "";
    return {
      code,
      name: m ? m[2] : opt,
      group: g.label,
      description: DEFAULT_MINISTRY_DESCRIPTIONS[code] ?? "",
      active: true,
      sortOrder: gi * 100 + oi,
    };
  })
);

/**
 * Merge the built-in defaults into an edited catalog (the treasurer's "Load
 * defaults" action). Non-destructive: a row whose code matches a default gets
 * the default description only when its own is blank, and nothing else about
 * existing rows changes — treasurer-authored text always wins, and archived
 * categories stay archived (a code present on ANY row, active or archived,
 * counts as present, so loading defaults never resurrects one). Defaults whose
 * codes are absent entirely come back in `missing`, in default-list order, for
 * the caller to append as new rows.
 */
export function mergeDefaultMinistries<T extends { code: string; description: string }>(
  rows: readonly T[]
): { rows: T[]; missing: MinistryEntry[]; filled: number } {
  const byCode = new Map(DEFAULT_MINISTRY_ENTRIES.map((e) => [e.code, e]));
  let filled = 0;
  const merged = rows.map((r) => {
    const def = byCode.get(r.code);
    if (!def || !def.description || r.description.trim() !== "") return r;
    filled += 1;
    return { ...r, description: def.description };
  });
  const present = new Set(rows.map((r) => r.code));
  const missing = DEFAULT_MINISTRY_ENTRIES.filter((e) => !present.has(e.code));
  return { rows: merged, missing, filled };
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
