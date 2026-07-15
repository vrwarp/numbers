import { NextResponse } from "next/server";
import { handleApi } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * The verified-mirror member directory for the admin Members tab
 * (docs/ADMIN.md): role, e-sign enrollment status, rollout allowlist, and
 * activity counts across all users. The cryptographic vouch-for chain is
 * rendered client-side from the roster ledger; this is the day-to-day roster
 * mirror. Admin-only (the cross-tenant read is intentional). Read-only.
 */
export async function GET() {
  return handleApi(async () => {
    await requireAdmin();
    const users = await prisma.user.findMany({
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        esignAllowed: true,
        createdAt: true,
        signerIdentity: { select: { status: true, attestedAt: true, publicKey: true } },
        _count: { select: { receipts: true, reimbursements: true } },
      },
    });
    return NextResponse.json({
      members: users.map((u) => ({
        userId: u.id,
        email: u.email,
        name: u.fullName || u.email,
        role: u.role,
        allowed: u.esignAllowed,
        identityStatus: u.signerIdentity?.status ?? null,
        hasKey: !!u.signerIdentity?.publicKey,
        attestedAt: u.signerIdentity?.attestedAt ?? null,
        createdAt: u.createdAt,
        receipts: u._count.receipts,
        claims: u._count.reimbursements,
      })),
    });
  });
}
