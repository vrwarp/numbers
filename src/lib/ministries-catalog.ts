import { prisma } from "@/lib/prisma";
import {
  DEFAULT_MINISTRY_ENTRIES,
  composeMinistry,
  ministryGroupsFromEntries,
  type MinistryEntry,
} from "@/lib/ministries";

/**
 * Reads of the church-wide budget-category catalog (the `Ministry` table).
 * While the table is EMPTY every loader falls back to the built-in defaults,
 * so a fresh deployment behaves exactly like the old hard-coded list and the
 * treasurer's editor opens pre-filled with today's chart of accounts. Once a
 * single row exists the table is authoritative. SERVER ONLY (prisma).
 */

/** A catalog entry with its DB id (null for a built-in default entry). */
export type MinistryRow = MinistryEntry & { id: string | null };

type DbRow = {
  code: string;
  name: string;
  group: string;
  description: string;
  active: boolean;
  sortOrder: number;
};

function toEntry(r: DbRow): MinistryEntry {
  return {
    code: r.code,
    name: r.name,
    group: r.group,
    description: r.description,
    active: r.active,
    sortOrder: r.sortOrder,
  };
}

/** Every catalog row (active + archived), for the treasurer's editor. */
export async function loadAllMinistryRows(): Promise<MinistryRow[]> {
  const rows = await prisma.ministry.findMany({ orderBy: { sortOrder: "asc" } });
  if (rows.length === 0) return DEFAULT_MINISTRY_ENTRIES.map((e) => ({ id: null, ...e }));
  return rows.map((r) => ({ id: r.id, ...toEntry(r) }));
}

/** Active entries in display order — the dropdown + AI-suggest source. A
 *  non-empty but all-archived table returns [] (no default resurrection). */
export async function loadActiveMinistryEntries(): Promise<MinistryEntry[]> {
  const rows = await prisma.ministry.findMany({ orderBy: { sortOrder: "asc" } });
  if (rows.length === 0) return DEFAULT_MINISTRY_ENTRIES.filter((e) => e.active);
  return rows.filter((r) => r.active).map(toEntry);
}

/** Active categories as grouped dropdown options ({label, options}). */
export async function loadActiveMinistryGroups(): Promise<{ label: string; options: string[] }[]> {
  return ministryGroupsFromEntries(await loadActiveMinistryEntries());
}

/** Flat composed values of every active category — the AI validation set. */
export async function loadActiveMinistryValues(): Promise<string[]> {
  return (await loadActiveMinistryEntries()).map((e) => composeMinistry(e.code, e.name));
}
