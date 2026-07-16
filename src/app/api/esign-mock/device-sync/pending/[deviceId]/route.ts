import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { isEsignMock } from "@/lib/config";

export const runtime = "nodejs";

/** Single pending-device request (mock stand-in for charproof's Firestore doc). */

const DEVICE_ID = /^[A-Za-z0-9_-]{4,128}$/;

async function ctxDevice(ctx: { params: Promise<{ deviceId: string }> }) {
  if (!isEsignMock()) throw new ApiError(404, "Not found");
  const userId = await requireUserId();
  const { deviceId } = await ctx.params;
  if (!DEVICE_ID.test(deviceId)) throw new ApiError(400, "Bad device id");
  return { userId, deviceId };
}

export async function GET(_req: Request, ctx: { params: Promise<{ deviceId: string }> }) {
  return handleApi(async () => {
    const { userId, deviceId } = await ctxDevice(ctx);
    const row = await prisma.esignPendingDevice.findUnique({
      where: { userId_deviceId: { userId, deviceId } },
    });
    return NextResponse.json({ device: row ? JSON.parse(row.data) : null });
  });
}

export async function PUT(req: Request, ctx: { params: Promise<{ deviceId: string }> }) {
  return handleApi(async () => {
    const { userId, deviceId } = await ctxDevice(ctx);
    const data = (await req.json().catch(() => ({}))) as { data?: unknown };
    if (!data.data) throw new ApiError(400, "Missing data");
    const json = JSON.stringify(data.data);
    if (json.length > 100_000) throw new ApiError(400, "Request too large");
    await prisma.esignPendingDevice.upsert({
      where: { userId_deviceId: { userId, deviceId } },
      create: { userId, deviceId, data: json },
      update: { data: json },
    });
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ deviceId: string }> }) {
  return handleApi(async () => {
    const { userId, deviceId } = await ctxDevice(ctx);
    await prisma.esignPendingDevice.deleteMany({ where: { userId, deviceId } });
    return NextResponse.json({ ok: true });
  });
}
