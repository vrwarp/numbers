import { prisma } from "@/lib/prisma";

/**
 * The ratified role-read grant (docs/SEARCH_DESIGN.md §6.3, ESIGN_DESIGN §6.3
 * amendment): holders of a verified approver/treasurer/admin role — the
 * signature-verified User.role mirror, never ADMIN_EMAILS — may READ receipts
 * and claims across all tenants (search summaries + receipt files; drafts and
 * never-claimed receipts included). Writes remain owner-only. Duty pauses do
 * not narrow reads (routing, not access); role loss does — re-read per request.
 */
export async function hasRoleReadGrant(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  return ["approver", "treasurer", "admin"].includes(user?.role ?? "");
}
