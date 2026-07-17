import { prisma } from "@/lib/prisma";

/**
 * The role-read grant (docs/SEARCH_DESIGN.md §6.3, ESIGN_DESIGN §6.3 amendment)
 * derives from the signature-verified `User.role` mirror — NEVER from
 * ADMIN_EMAILS — AND now respects the A10 self-service duty pauses: pausing a
 * duty narrows what that role-holder can search, per-duty. Two capabilities:
 *
 *  - `canAll` — the whole-church read grant: read all receipts + claims (drafts
 *    and never-claimed receipts included) and open any receipt's file/preview.
 *    Requires at least one ACTIVE (un-paused) duty the role grants — the holder
 *    is still serving in some cross-tenant capacity. A treasurer who pauses
 *    only Approvals keeps it (Finance still active); it goes once every relevant
 *    duty is paused.
 *  - `canDecided` — the "Claims I decided" browse: requires the APPROVALS duty
 *    active, since it IS the approver's decision set. (Implies `canAll`.)
 *
 * Writes stay owner-only. Role loss and duty pauses both narrow reads; the
 * mirror + flags are re-read on every request.
 */

export type RoleDutyFlags = {
  role: string;
  approvalsPaused: boolean;
  financePaused: boolean;
  adminPaused: boolean;
};

export type SearchCapabilities = { canAll: boolean; canDecided: boolean };

export function searchCapabilities(u: RoleDutyFlags): SearchCapabilities {
  const grantsApprovals = ["approver", "treasurer", "admin"].includes(u.role);
  const grantsFinance = ["treasurer", "admin"].includes(u.role);
  const grantsAdmin = u.role === "admin";
  const approvalsActive = grantsApprovals && !u.approvalsPaused;
  const financeActive = grantsFinance && !u.financePaused;
  const adminActive = grantsAdmin && !u.adminPaused;
  return {
    canAll: approvalsActive || financeActive || adminActive,
    canDecided: approvalsActive,
  };
}

export async function searchCapabilitiesFor(userId: string): Promise<SearchCapabilities> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, approvalsPaused: true, financePaused: true, adminPaused: true },
  });
  return u ? searchCapabilities(u) : { canAll: false, canDecided: false };
}

/** Cross-tenant READ grant for receipt files/previews and whole-church search
 *  — the `canAll` capability (respects duty pauses; §6.3). A fully-paused
 *  role-holder reads like a member. */
export async function hasRoleReadGrant(userId: string): Promise<boolean> {
  return (await searchCapabilitiesFor(userId)).canAll;
}
