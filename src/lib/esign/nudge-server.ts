import { prisma } from "@/lib/prisma";
import { configValue } from "@/lib/config-file";
import { getRegistry, esignAccessAllowed } from "@/lib/esign/server";
import {
  dutyCardCollapsed,
  memberCardCollapsed,
  parseNudgeState,
  pendingStale,
  PAPER_REPEAT_MIN_AGE_DAYS,
  type HomeNudgeDecision,
  type SetupState,
} from "@/lib/esign/nudge-state";

export type { HomeNudgeDecision, SetupState };

/**
 * Server-side decision for the home-page nudge slot and the nav's setup row
 * (docs/ESIGN_SETUP_DISCOVERABILITY.md §3.3/§3.5). One shared predicate so the
 * RSC render, the badges endpoint, and the client island can never disagree
 * about who is "eligible but not set up".
 *
 * Layer rule: the PERSUASION pieces (home cards, paper-repeat) honor the admin
 * kill-switch; the wayfinding row (menu) never does — switching persuasion off
 * must not remove the honest door.
 */

/** Admin kill-switch for the persuasion layer (ESIGN_NUDGES_OFF, default on). */
export function esignNudgesEnabled(): boolean {
  return configValue("ESIGN_NUDGES_OFF") !== "1";
}

export interface EsignSetupSnapshot {
  /** null = nothing e-sign related may render for this user (A5/A8 posture). */
  eligible: boolean;
  identityStatus: string | null;
  /** Wayfinding menu row (EP7): independent of the kill-switch. null = no row. */
  menuRow: { kind: "setup" | "qr"; chip: SetupState | null } | null;
  /** Home-slot card (EP1 system): null = render nothing. */
  homeCard: HomeNudgeDecision | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** ≥1 attested approver-plus OR ≥2 attested members besides the viewer — the
 *  church can actually serve a new pending queue. Count stays server-side
 *  (never returned to clients): a null-state member must not be able to size
 *  the roster through a nudge predicate. */
async function vouchCapacityFor(userId: string): Promise<boolean> {
  const others = await prisma.signerIdentity.findMany({
    where: { status: "attested", userId: { not: userId } },
    select: { user: { select: { role: true } } },
  });
  if (others.length >= 2) return true;
  return others.some((o) =>
    ["approver", "secretary", "chairman", "treasurer", "admin"].includes(o.user.role)
  );
}

export async function esignSetupSnapshot(userId: string): Promise<EsignSetupSnapshot> {
  const none: EsignSetupSnapshot = {
    eligible: false,
    identityStatus: null,
    menuRow: null,
    homeCard: null,
  };
  const registry = await getRegistry();
  if (!registry?.enabled) return none;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      esignAllowed: true,
      prefersPaper: true,
      esignNudgesJson: true,
      signerIdentity: { select: { status: true, createdAt: true } },
      positionHolders: {
        where: { position: { active: true } },
        select: { positionId: true },
        take: 1,
      },
    },
  });
  if (!user || !esignAccessAllowed(registry, user)) return none;

  const now = new Date();
  const identityStatus = user.signerIdentity?.status ?? null;
  const state: SetupState | null =
    identityStatus === null ? "none" : identityStatus === "pending" ? "pending" : null;
  const nudges = parseNudgeState(user.esignNudgesJson);
  const isDuty = user.positionHolders.length > 0;

  // EP7 menu row — wayfinding, so it survives decline/prefersPaper (a door,
  // not a to-do) but drops its chip once the user has said "paper" either way.
  // Revoked keeps the row chip-less (the profile card owns that story);
  // attested has no row at all.
  const menuRow: EsignSetupSnapshot["menuRow"] =
    identityStatus === "attested"
      ? null
      : {
          kind: state === "pending" ? "qr" : "setup",
          chip: state && !nudges.declined && !user.prefersPaper ? state : null,
        };

  const base: EsignSetupSnapshot = { eligible: true, identityStatus, menuRow, homeCard: null };

  // Everything below is the persuasion layer.
  if (!esignNudgesEnabled() || user.prefersPaper) return base;

  // Closure (one-shot, attested): "you're set up — the parked claim can move".
  if (identityStatus === "attested") {
    if (nudges.closureShown) return base;
    const parked = await prisma.reimbursement.findFirst({
      where: { userId, status: "generated" },
      orderBy: { createdAt: "desc" },
      select: { id: true, totalCents: true, createdAt: true },
    });
    if (!parked) return base; // accepted edge: nothing to point at, no card
    return {
      ...base,
      homeCard: {
        variant: "closure",
        state: "none",
        collapsed: false,
        paperRepeat: false,
        closureClaim: {
          id: parked.id,
          totalCents: parked.totalCents,
          createdAt: parked.createdAt.toISOString(),
        },
      },
    };
  }

  if (!state) return base; // revoked: never a cheerful card

  // Duty card (Position holders, null|pending): outranks the member card,
  // snooze-capped, silenced only by attested / position loss / prefersPaper.
  if (isDuty) {
    const snooze = dutyCardCollapsed(nudges, now);
    return {
      ...base,
      homeCard:
        snooze === "snoozed"
          ? null
          : {
              variant: "duty",
              state,
              collapsed: snooze === "capped",
              paperRepeat: false,
              closureClaim: null,
            },
    };
  }

  // Member card. Terminal decline; capacity gate; first-run suppression and
  // profile-nudge arbitration happen in the page (it owns those signals).
  if (state === "none" && nudges.declined) {
    // Bounded once-ever re-ask for accounts with NO dismissal record — a
    // declined account is not that account.
    return base;
  }
  const collapsed =
    state === "none"
      ? memberCardCollapsed(nudges, now)
      : pendingStale(user.signerIdentity?.createdAt, now);

  // Paper-repeat re-ask (state none only): a prior claim sat generated with no
  // ceremony for two weeks, and they're back. Once per account, silent-ignorers
  // only (no decline; decay may have collapsed the card — the re-ask un-collapses
  // it once).
  let paperRepeat = false;
  if (state === "none" && !nudges.paperRepeatShown) {
    const aged = await prisma.reimbursement.findFirst({
      where: {
        userId,
        status: "generated",
        submitSeq: 0,
        generatedAt: { lt: new Date(now.getTime() - PAPER_REPEAT_MIN_AGE_DAYS * DAY_MS) },
      },
      select: { id: true },
    });
    paperRepeat = !!aged;
  }

  if (state === "none" && !(await vouchCapacityFor(userId))) return base;

  return {
    ...base,
    homeCard: {
      variant: "member",
      state,
      collapsed: collapsed && !paperRepeat,
      paperRepeat,
      closureClaim: null,
    },
  };
}
