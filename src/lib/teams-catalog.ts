import { prisma } from "@/lib/prisma";

/**
 * Server reads for Teams (docs/SEARCH_DESIGN.md §6.3 team amendment): the
 * editor payload and the TEAM READ GRANT — the membership-derived, read-only
 * visibility expansion over receipts/claims whose line items carry one of the
 * member's teams' budget-category codes on a NON-DRAFT claim.
 *
 * Grain (ratified): a receipt is visible only when its OWN line item's ministry
 * matches (least-privilege on mixed-ministry claims); a claim is visible when
 * ANY of its line items matches. Drafts never qualify — a draft isn't a
 * reimbursement request yet, and its ministries flap mid-edit. Excluded rows
 * don't count. Matching is by parsed 3-digit CODE (`ministry` starts with
 * "<code> ") because composed strings are never migrated on catalog renames.
 *
 * The grant is re-read on every request from live membership — never cached,
 * never role- or ADMIN_EMAILS-derived. Writes stay owner-only. SERVER ONLY.
 */

/** A team as the editor renders it. */
export interface TeamRow {
  id: string;
  name: string;
  description: string;
  active: boolean;
  sortOrder: number;
  members: { userId: string; name: string; email: string; role: string }[];
  /** Associated budget-category codes ("210", ...). */
  codes: string[];
}

/** A candidate the editor can add as a member — every known user. */
export interface TeamMemberOption {
  userId: string;
  name: string;
  email: string;
  role: string;
}

/** Every team with members + codes (any active state), for the editor. */
export async function loadTeamsWithDetails(): Promise<TeamRow[]> {
  const teams = await prisma.team.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      members: {
        include: {
          user: { select: { id: true, fullName: true, email: true, role: true } },
        },
      },
      ministries: { select: { code: true } },
    },
  });
  return teams.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    active: t.active,
    sortOrder: t.sortOrder,
    members: t.members
      .map((m) => ({
        userId: m.userId,
        name: m.user.fullName || m.user.email,
        email: m.user.email,
        role: m.user.role,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    codes: t.ministries.map((m) => m.code).sort(),
  }));
}

/** The member directory the team editor offers, name-sorted. */
export async function loadTeamMemberOptions(): Promise<TeamMemberOption[]> {
  const users = await prisma.user.findMany({
    select: { id: true, fullName: true, email: true, role: true },
  });
  return users
    .map((u) => ({
      userId: u.id,
      name: u.fullName || u.email,
      email: u.email,
      role: u.role,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Distinct budget-category codes of the ACTIVE teams this user belongs to.
 *  Empty array = no team read grant. */
export async function teamMinistryCodesFor(userId: string): Promise<string[]> {
  const rows = await prisma.teamMinistry.findMany({
    where: { team: { active: true, members: { some: { userId } } } },
    select: { code: true },
  });
  return [...new Set(rows.map((r) => r.code))];
}

/** Whether this user holds any team read grant at all: member of an active
 *  team that has at least one budget-category code. Drives `canTeam`. */
export async function hasTeamReadGrant(userId: string): Promise<boolean> {
  const row = await prisma.teamMember.findFirst({
    where: { userId, team: { active: true, ministries: { some: {} } } },
    select: { id: true },
  });
  return !!row;
}

/** The line-item filter matching the team grant: a non-excluded row on a
 *  non-draft claim whose composed ministry starts with one of the codes. */
function grantRowWhere(codes: string[]) {
  return {
    isExcluded: false,
    reimbursement: { status: { not: "draft" } },
    OR: codes.map((c) => ({ ministry: { startsWith: `${c} ` } })),
  };
}

/**
 * The allowed-id sets for the search team scope, mirroring decidedPrefetch:
 * receipts whose own line item matches (grain), and the claims containing any
 * matching line item. Both empty when the user has no grant.
 */
export async function teamPrefetch(
  userId: string
): Promise<{ receiptIds: string[]; claimIds: string[] }> {
  const codes = await teamMinistryCodesFor(userId);
  if (!codes.length) return { receiptIds: [], claimIds: [] };
  const rows = await prisma.lineItem.findMany({
    where: grantRowWhere(codes),
    select: { receiptId: true, reimbursementId: true },
  });
  return {
    receiptIds: [...new Set(rows.map((r) => r.receiptId))],
    claimIds: [...new Set(rows.map((r) => r.reimbursementId))],
  };
}

/** Per-receipt team grant check for the file/preview routes: does this receipt
 *  have a qualifying line item under one of my teams' codes? */
export async function canReadReceiptViaTeam(userId: string, receiptId: string): Promise<boolean> {
  const codes = await teamMinistryCodesFor(userId);
  if (!codes.length) return false;
  const row = await prisma.lineItem.findFirst({
    where: { receiptId, ...grantRowWhere(codes) },
    select: { id: true },
  });
  return !!row;
}
