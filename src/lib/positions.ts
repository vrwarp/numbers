/**
 * Positions — custom approval roles (e.g. "Deacon of Missions", "Office
 * Staff") the treasurer assigns to people and sets as the default approver for
 * budget categories (docs/agent/ARCHITECTURE.md).
 *
 * A Position is a PURE APP-LAYER ROUTING LABEL, the same posture as the A10
 * duty pauses: it never touches User.role, the roster ledger, or ledger
 * validity. Its only effect is to PRE-FILL the approver picker on a claim; the
 * submitter still signs the approver into the SUBMIT payload themselves, and
 * the decision route + offline verifier re-check the real Approver+ role at
 * signing time. Holding a Position grants no authority on its own.
 *
 * This module is dependency-free (no prisma) so both client and server share
 * the eligibility rule and the pre-fill selection, and so both are unit-tested
 * without a database. Prisma reads + the claim wiring live in
 * positions-catalog.ts.
 */

import { parseMinistryCode } from "@/lib/ministries";
import { APPROVER_PLUS_ROLES } from "@/lib/esign/types";

/** Whether a holder can currently be pre-filled as (and actually act as) an
 *  approver. Mirrors the approver picker / submit preflight rule exactly:
 *  attested key + Approver-or-above role + approvals not paused (A10).
 *   - "ok"           — can approve now (the only state that ever pre-fills)
 *   - "paused"       — Approver+ and attested, but self-paused approvals
 *   - "cannotApprove"— not an Approver-or-above, or not attested (needs a grant
 *                      / needs to enroll before they can sign anything) */
export type ApproverEligibility = "ok" | "paused" | "cannotApprove";

export const APPROVER_ROLES = APPROVER_PLUS_ROLES;

export function approverEligibility(u: {
  role: string;
  attested: boolean;
  approvalsPaused: boolean;
}): ApproverEligibility {
  const isApprover = (APPROVER_ROLES as readonly string[]).includes(u.role);
  if (!isApprover || !u.attested) return "cannotApprove";
  if (u.approvalsPaused) return "paused";
  return "ok";
}

/** A catalog entry for a Position (a custom approval role), independent of any
 *  holders. Mirrors the MinistryEntry shape: the built-in defaults are the seed
 *  the treasurer's editor starts from and the fallback the loader serves while
 *  the `Position` table is empty.
 *
 *  `name` is the canonical English name — it is what gets STORED on the
 *  `Position` row and printed nowhere (positions never reach the PDF or the
 *  signed payload). `key` is the stable i18n handle: display code translates a
 *  built-in via `Positions.builtin.<key>` (see builtinPositionKey), falling back
 *  to the stored name for custom, treasurer-authored positions. */
export interface PositionEntry {
  key: string;
  name: string;
  description: string;
  active: boolean;
  sortOrder: number;
}

/** The built-in default Positions as [i18n key, canonical English name] pairs.
 *  `as const` keeps the keys a literal union (BuiltinPositionKey) so the display
 *  hook can pass them to a typed next-intl `t`. Order matches the church's
 *  roster. */
const BUILTIN_POSITIONS = [
  ["chineseCaring", "Chinese Caring Deacon"],
  ["chineseEvangelism", "Chinese Evangelism Deacon"],
  ["childrensMinistry", "Children's Ministry Deacon"],
  ["englishDiscipleship", "English Discipleship Deacon"],
  ["englishEvangelism", "English Evangelism Deacon"],
  ["finance", "Finance Deacon"],
  ["generalAffairs", "General Affairs Deacon"],
  ["missions", "Missions Deacon"],
  ["property", "Property Deacon"],
  ["worship", "Worship Deacon"],
] as const;

/** The i18n key of a built-in position — a leaf of `Positions.builtin.*`. */
export type BuiltinPositionKey = (typeof BUILTIN_POSITIONS)[number][0];

/** The built-in default Positions — the church's standing deacon roster. On a
 *  fresh deployment the "Load default positions" button seeds these (holders
 *  unassigned) so the treasurer only has to assign people. Unlike ministry
 *  names, these ARE localized: they render through `Positions.builtin.<key>`
 *  (en/zh-Hans/zh-Hant) at every display site while the canonical English name
 *  is what persists. */
export const DEFAULT_POSITION_ENTRIES: PositionEntry[] = BUILTIN_POSITIONS.map(
  ([key, name], i) => ({ key, name, description: "", active: true, sortOrder: i })
);

/** Canonical English name → built-in i18n key, or null for a custom position.
 *  The display boundary uses this to decide whether a stored position name is a
 *  localizable built-in (translate via `Positions.builtin.<key>`) or arbitrary
 *  church data to show verbatim. A treasurer who renames a built-in in the
 *  editor turns it custom — the match falls through and their text is shown as
 *  typed, which is the intended behavior. Dependency-free so client and server
 *  share it. */
const BUILTIN_KEY_BY_NAME: ReadonlyMap<string, BuiltinPositionKey> = new Map(
  BUILTIN_POSITIONS.map(([key, name]) => [name, key])
);
export function builtinPositionKey(name: string): BuiltinPositionKey | null {
  return BUILTIN_KEY_BY_NAME.get(name.trim()) ?? null;
}

/** A position's name in every locale the app carries. `name` is the required
 *  English fallback; the two Chinese fields are the optional per-locale names a
 *  treasurer types for a CUSTOM position (null = fall back to `name`). Built-in
 *  defaults leave these null and localize via `Positions.builtin.<key>` instead.
 *  This is the shape every display site receives so the client can localize a
 *  custom name without a refetch when the language is switched. */
export interface PositionNameSet {
  name: string;
  nameZhHans: string | null;
  nameZhHant: string | null;
}

/** The locale-appropriate name of a CUSTOM position: the matching per-locale
 *  column when the treasurer filled it, else the English `name`. Built-ins are
 *  handled by the catalog (builtinPositionKey) before this is reached. Pure so
 *  client and server share it. */
export function customPositionName(set: PositionNameSet, locale: string): string {
  if (locale === "zh-Hans") return set.nameZhHans?.trim() || set.name;
  if (locale === "zh-Hant") return set.nameZhHant?.trim() || set.name;
  return set.name;
}

/** A position as the pre-fill selector needs it: its name set (for the
 *  pre-fill label + tie-break), whether it still routes, and the userIds of its
 *  holders in assignment order (primary first). */
export interface PositionForSuggest extends PositionNameSet {
  active: boolean;
  holderUserIds: string[];
}

export interface SuggestInputs {
  /** Active line items on the claim (excluded rows already filtered out). */
  lineItems: { ministry: string; amountCents: number }[];
  /** Active budget category code → its default position id (null = none). */
  categoryDefault: Map<string, string | null>;
  positions: Map<string, PositionForSuggest>;
  /** Holder userId → current eligibility. */
  eligibility: Map<string, ApproverEligibility>;
  /** The claim owner (requestor) — never pre-filled as their own approver. */
  ownerUserId: string;
}

export interface SuggestedApprover {
  userId: string;
  positionId: string;
  /** The resolved position's full name set, so the review screen can localize
   *  the "pre-filled from …" note in the reader's language. */
  positionName: PositionNameSet;
}

/**
 * The approver to pre-fill on a claim, or null when nothing resolves.
 *
 * A claim can span several budget categories with different default positions,
 * but the picker commits to ONE approver — so we GUESS: the category carrying
 * the greatest dollar total wins (ties broken by line-item count, then name).
 * We then take that position's first approval-eligible, non-owner holder; if a
 * winning position has no such holder we fall through to the next-ranked
 * position rather than pre-filling nobody. Ineligible/paused holders and the
 * requestor themselves are skipped (hidden from routing), never pre-filled.
 */
export function pickSuggestedApprover(inp: SuggestInputs): SuggestedApprover | null {
  const dollars = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const li of inp.lineItems) {
    const code = parseMinistryCode(li.ministry);
    if (!code) continue;
    const positionId = inp.categoryDefault.get(code) ?? null;
    if (!positionId) continue;
    const pos = inp.positions.get(positionId);
    if (!pos || !pos.active) continue;
    dollars.set(positionId, (dollars.get(positionId) ?? 0) + Math.abs(li.amountCents));
    counts.set(positionId, (counts.get(positionId) ?? 0) + 1);
  }
  if (dollars.size === 0) return null;

  const ranked = [...dollars.keys()].sort((a, b) => {
    const byDollars = (dollars.get(b) ?? 0) - (dollars.get(a) ?? 0);
    if (byDollars !== 0) return byDollars;
    const byCount = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
    if (byCount !== 0) return byCount;
    return inp.positions.get(a)!.name.localeCompare(inp.positions.get(b)!.name);
  });

  for (const positionId of ranked) {
    const pos = inp.positions.get(positionId)!;
    for (const userId of pos.holderUserIds) {
      if (userId === inp.ownerUserId) continue;
      if (inp.eligibility.get(userId) === "ok") {
        const { name, nameZhHans, nameZhHant } = pos;
        return { userId, positionId, positionName: { name, nameZhHans, nameZhHant } };
      }
    }
  }
  return null;
}
