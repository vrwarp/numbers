import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { resolveLocale } from "@/i18n/request";

export const runtime = "nodejs";

/**
 * §7.7 client maintenance contract — ONE idempotent route. POST is
 * upsert-as-ping: registers/refreshes this installation's token, re-captures
 * the device's resolved locale (§9), and reports whether the token was known
 * — which feeds the §8.7 reconnect chip. Re-parenting a token that belongs
 * to another account happens ONLY on an explicit registration (§8.6); a
 * background ping never steals. Token strings are never returned by any GET
 * (§11) — the device list carries labels and timestamps only.
 */

const PostSchema = z.object({
  token: z.string().min(8).max(4096),
  /** Explicit user action (§8.3 enable / §8.6 sign-in registration) — allowed
   *  to re-parent; background pings omit it. */
  register: z.boolean().optional(),
  /** Trimmed UA label for the device list, e.g. "Safari · iPhone". */
  label: z.string().max(120).optional(),
});

type DeviceRow = { id: string; label: string; lastSeenAt: Date; current: boolean };

async function deviceList(userId: string, currentTokenId: string | null): Promise<DeviceRow[]> {
  const rows = await prisma.pushToken.findMany({
    where: { userId },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, userAgent: true, lastSeenAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.userAgent,
    lastSeenAt: r.lastSeenAt,
    current: r.id === currentTokenId,
  }));
}

export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const parsed = PostSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid token payload", "push.invalidToken");
    const { token, register, label } = parsed.data;
    const locale = await resolveLocale();

    const existing = await prisma.pushToken.findUnique({ where: { token } });
    let known = false;
    let rowId: string | null = null;

    if (existing && existing.userId === userId) {
      known = true;
      rowId = existing.id;
      await prisma.pushToken.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date(), locale, ...(label ? { userAgent: label } : {}) },
      });
    } else if (existing && register) {
      // §8.6: the token follows the signed-in account on explicit
      // registration; the previous owner's zero-device banner catches the loss.
      rowId = existing.id;
      await prisma.pushToken.update({
        where: { id: existing.id },
        data: { userId, lastSeenAt: new Date(), locale, userAgent: label ?? existing.userAgent },
      });
    } else if (!existing && register) {
      const created = await prisma.pushToken.create({
        data: { userId, token, locale, userAgent: label ?? "" },
      });
      rowId = created.id;
    }
    // (!existing && !register) → a ping for a token the server no longer has:
    // known stays false, nothing is created — the reconnect chip's signal.

    const devices = await deviceList(userId, rowId);
    return NextResponse.json({
      known,
      live: rowId !== null,
      devices,
    });
  });
}

const DeleteSchema = z.object({
  /** Delete by token (this installation, e.g. §8.6 sign-out)… */
  token: z.string().min(8).max(4096).optional(),
  /** …or by row id (removing another device from the profile card). */
  id: z.string().max(64).optional(),
});

export async function DELETE(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const parsed = DeleteSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success || (!parsed.data.token && !parsed.data.id)) {
      throw new ApiError(400, "Invalid token payload", "push.invalidToken");
    }
    // Owner-scoped delete (invariant 2): a miss is indistinguishable from
    // someone else's row.
    await prisma.pushToken.deleteMany({
      where: {
        userId,
        ...(parsed.data.token ? { token: parsed.data.token } : { id: parsed.data.id }),
      },
    });
    const devices = await deviceList(userId, null);
    return NextResponse.json({ ok: true, devices });
  });
}

export async function GET() {
  return handleApi(async () => {
    const userId = await requireUserId();
    const devices = await deviceList(userId, null);
    return NextResponse.json({ devices });
  });
}
