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

/** A position as the pre-fill selector needs it: whether it still routes and
 *  the userIds of its holders in assignment order (primary first). */
export interface PositionForSuggest {
  name: string;
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
  positionName: string;
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
        return { userId, positionId, positionName: pos.name };
      }
    }
  }
  return null;
}
