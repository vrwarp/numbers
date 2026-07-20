import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi } from "@/lib/api";
import { esignAccessAllowed, getRegistry } from "@/lib/esign/server";
import { esignNudgesEnabled } from "@/lib/esign/nudge-server";
import { parseNudgeState } from "@/lib/esign/nudge-state";

export const runtime = "nodejs";

/** NavBar badge counts (docs/ESIGN_DESIGN.md §6.1) — there are no
 *  notifications, so the UI must surface pending work. Cheap mirror reads. */
export async function GET() {
  return handleApi(async () => {
    const userId = await requireUserId();
    const registry = await getRegistry();
    // Master switch off ⇒ the nav shows nothing e-sign related (A5).
    if (!registry?.enabled) return NextResponse.json({ enabled: false });
    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        esignAllowed: true,
        approvalsPaused: true,
        financePaused: true,
        prefersPaper: true,
        esignNudgesJson: true,
        signerIdentity: { select: { status: true } },
      },
    });
    // Outside the rollout allowlist (A8) ⇒ same nothing-to-see as switched off.
    if (me && !esignAccessAllowed(registry, me)) return NextResponse.json({ enabled: false });
    // Claims already assigned still count while paused (A10) — pausing stops
    // NEW submissions, not the ones waiting on you.
    const approvals = await prisma.reimbursement.count({
      where: { approverUserId: userId, status: "submitted" },
    });
    // A paused treasurer loses the finance queue outright (null = no tab).
    const finance =
      (me?.role === "treasurer" || me?.role === "admin") && !me.financePaused
        ? await prisma.reimbursement.count({ where: { status: "approved" } })
        : null;
    // EP7 wayfinding row (docs/ESIGN_SETUP_DISCOVERABILITY.md §3.3): the
    // account menu's setup door. All new fields ride ONLY this enabled branch
    // — pre-eligibility callers still get the bare {enabled:false}. The row
    // survives a decline/prefers-paper (a door, not a to-do) but drops its
    // to-do chip; attested users get no row; revoked keeps a chip-less row
    // (the profile card owns that story). Wayfinding — NOT gated by the
    // persuasion kill-switch (which the home-card island reads from
    // `nudgesEnabled` to clear cards within one poll).
    const identityStatus = me?.signerIdentity?.status ?? null;
    const nudges = parseNudgeState(me?.esignNudgesJson);
    const optedOut = !!nudges.declined || !!me?.prefersPaper;
    const setup =
      identityStatus === "attested"
        ? null
        : {
            kind: identityStatus === "pending" ? ("qr" as const) : ("setup" as const),
            chip:
              identityStatus === "revoked" || optedOut
                ? null
                : identityStatus === "pending"
                  ? ("pending" as const)
                  : ("none" as const),
          };
    return NextResponse.json({
      enabled: true,
      role: me?.role ?? "member",
      approvals,
      approvalsPaused: me?.approvalsPaused ?? false,
      finance,
      // Only attested members can vouch (§4.3) — gates the nav's Vouch tab.
      vouch: me?.signerIdentity?.status === "attested",
      identityStatus,
      setup,
      nudgesEnabled: esignNudgesEnabled(),
    });
  });
}
