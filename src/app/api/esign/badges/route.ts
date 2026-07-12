import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi } from "@/lib/api";
import { esignAccessAllowed, getRegistry } from "@/lib/esign/server";

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
      select: { role: true, esignAllowed: true },
    });
    // Outside the rollout allowlist (A8) ⇒ same nothing-to-see as switched off.
    if (me && !esignAccessAllowed(registry, me)) return NextResponse.json({ enabled: false });
    const approvals = await prisma.reimbursement.count({
      where: { approverUserId: userId, status: "submitted" },
    });
    const finance =
      me?.role === "treasurer" || me?.role === "admin"
        ? await prisma.reimbursement.count({ where: { status: "approved" } })
        : null;
    return NextResponse.json({
      enabled: true,
      role: me?.role ?? "member",
      approvals,
      finance,
    });
  });
}
