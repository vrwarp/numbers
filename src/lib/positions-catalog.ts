import { prisma } from "@/lib/prisma";
import {
  approverEligibility,
  pickSuggestedApprover,
  type ApproverEligibility,
  type PositionForSuggest,
  type SuggestedApprover,
} from "@/lib/positions";

/**
 * Server reads of the Positions catalog (the `Position` / `PositionHolder`
 * tables) and the claim pre-fill resolution. SERVER ONLY (prisma). The pure
 * eligibility rule + selection live in positions.ts so they stay db-free and
 * unit-tested; this module just assembles the data.
 */

/** A holder as the editor renders it: who, their live eligibility, and order. */
export interface PositionHolderRow {
  userId: string;
  name: string;
  role: string;
  eligibility: ApproverEligibility;
  order: number;
}

/** A position with its holders, for the editor and the Budget Categories
 *  "routes to" display. */
export interface PositionRow {
  id: string;
  name: string;
  description: string;
  active: boolean;
  sortOrder: number;
  holders: PositionHolderRow[];
}

/** A candidate the editor can assign as a holder — every enrolled/known user,
 *  with the eligibility badge so a plain member is flagged before assignment. */
export interface PositionMember {
  userId: string;
  name: string;
  email: string;
  role: string;
  eligibility: ApproverEligibility;
}

type UserLite = {
  id: string;
  fullName: string | null;
  email: string;
  role: string;
  approvalsPaused: boolean;
  signerIdentity: { status: string } | null;
};

function eligibilityOf(u: UserLite): ApproverEligibility {
  return approverEligibility({
    role: u.role,
    attested: u.signerIdentity?.status === "attested",
    approvalsPaused: u.approvalsPaused,
  });
}

/** Every position with holders (any active state), for the editor. Empty until
 *  the treasurer creates positions — the editor offers a one-click "load
 *  defaults" (DEFAULT_POSITION_ENTRIES) from the empty state rather than the
 *  catalog silently materializing them. */
export async function loadPositionsWithHolders(): Promise<PositionRow[]> {
  const positions = await prisma.position.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      holders: {
        orderBy: { order: "asc" },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              role: true,
              approvalsPaused: true,
              signerIdentity: { select: { status: true } },
            },
          },
        },
      },
    },
  });
  return positions.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    active: p.active,
    sortOrder: p.sortOrder,
    holders: p.holders.map((h) => ({
      userId: h.userId,
      name: h.user.fullName || h.user.email,
      role: h.user.role,
      eligibility: eligibilityOf(h.user),
      order: h.order,
    })),
  }));
}

/** userId → the name of the first active Position they hold (by catalog
 *  sortOrder). Used to label a member by their custom approval role (Position)
 *  in the approver picker, falling back to the system role when absent. Members
 *  with no active position are simply not in the map. */
export async function loadMemberPositionNames(): Promise<Map<string, string>> {
  const positions = await prisma.position.findMany({
    where: { active: true },
    orderBy: { sortOrder: "asc" },
    include: { holders: { select: { userId: true } } },
  });
  const byUser = new Map<string, string>();
  for (const p of positions) {
    for (const h of p.holders) if (!byUser.has(h.userId)) byUser.set(h.userId, p.name);
  }
  return byUser;
}

/** The member directory the holder picker offers, name-sorted. */
export async function loadPositionMembers(): Promise<PositionMember[]> {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      fullName: true,
      email: true,
      role: true,
      approvalsPaused: true,
      signerIdentity: { select: { status: true } },
    },
  });
  return users
    .map((u) => ({
      userId: u.id,
      name: u.fullName || u.email,
      email: u.email,
      role: u.role,
      eligibility: eligibilityOf(u),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The approver to pre-fill on a claim, resolved from its line items' budget
 * categories → default positions → first eligible holder (see
 * pickSuggestedApprover). Returns null — never throws — when nothing routes or
 * the catalog can't be read, so a claim's review screen never depends on it
 * (positions are a convenience, not a gate). Short-circuits before touching the
 * positions tables when no active category even has a default.
 */
export async function resolveSuggestedApprover(claim: {
  userId: string;
  lineItems: { ministry: string; amountCents: number; isExcluded: boolean }[];
}): Promise<SuggestedApprover | null> {
  try {
    const ministries = await prisma.ministry.findMany({
      where: { active: true },
      select: { code: true, defaultPositionId: true },
    });
    const categoryDefault = new Map(ministries.map((m) => [m.code, m.defaultPositionId]));
    if (![...categoryDefault.values()].some((v) => v)) return null;

    const positions = await prisma.position.findMany({
      include: { holders: { orderBy: { order: "asc" }, select: { userId: true } } },
    });
    const positionMap = new Map<string, PositionForSuggest>(
      positions.map((p) => [
        p.id,
        { name: p.name, active: p.active, holderUserIds: p.holders.map((h) => h.userId) },
      ])
    );

    const holderIds = [...new Set(positions.flatMap((p) => p.holders.map((h) => h.userId)))];
    const users = holderIds.length
      ? await prisma.user.findMany({
          where: { id: { in: holderIds } },
          select: {
            id: true,
            role: true,
            approvalsPaused: true,
            signerIdentity: { select: { status: true } },
          },
        })
      : [];
    const eligibility = new Map<string, ApproverEligibility>(
      users.map((u) => [
        u.id,
        approverEligibility({
          role: u.role,
          attested: u.signerIdentity?.status === "attested",
          approvalsPaused: u.approvalsPaused,
        }),
      ])
    );

    return pickSuggestedApprover({
      lineItems: claim.lineItems
        .filter((li) => !li.isExcluded)
        .map((li) => ({ ministry: li.ministry, amountCents: li.amountCents })),
      categoryDefault,
      positions: positionMap,
      eligibility,
      ownerUserId: claim.userId,
    });
  } catch {
    return null;
  }
}
