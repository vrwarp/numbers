import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { currentUser } from "@/auth";
import { requireRegistry } from "@/lib/esign/server";

export const runtime = "nodejs";

/**
 * E-sign rollout allowlist (docs/ESIGN_DESIGN.md A8), admin-only — the
 * cross-tenant read of user names/emails is exactly the information the
 * vouch ceremony already shows members, and only the admin gets it here.
 * The allowlist gates the APP's e-sign surfaces; it never touches roster
 * validity (removing someone does not revoke anything they signed).
 */

async function requireAdmin() {
  const userId = await requireUserId();
  const user = await currentUser();
  if (user!.role !== "admin") throw new ApiError(404, "Not found");
  await requireRegistry();
  return userId;
}

export async function GET() {
  return handleApi(async () => {
    await requireAdmin();
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        esignAllowed: true,
        signerIdentity: { select: { status: true } },
      },
    });
    return NextResponse.json({
      users: users.map((u) => ({
        userId: u.id,
        email: u.email,
        name: u.fullName || u.email,
        role: u.role,
        allowed: u.esignAllowed,
        identityStatus: u.signerIdentity?.status ?? null,
      })),
    });
  });
}

export async function PATCH(req: Request) {
  return handleApi(async () => {
    const adminId = await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as { userId?: string; allowed?: boolean };
    if (typeof body.userId !== "string" || typeof body.allowed !== "boolean") {
      throw new ApiError(400, "userId and allowed are required");
    }
    const target = await prisma.user.findUnique({ where: { id: body.userId } });
    if (!target) throw new ApiError(404, "Not found");
    await prisma.$transaction([
      prisma.user.update({ where: { id: target.id }, data: { esignAllowed: body.allowed } }),
      prisma.auditEvent.create({
        data: {
          userId: adminId,
          action: "esign-allowlist",
          detail: JSON.stringify({ targetUserId: target.id, allowed: body.allowed }),
        },
      }),
    ]);
    return NextResponse.json({ ok: true, userId: target.id, allowed: body.allowed });
  });
}
