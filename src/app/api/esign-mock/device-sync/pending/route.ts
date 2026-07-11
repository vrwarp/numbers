import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { isEsignMock } from "@/lib/config";

export const runtime = "nodejs";

/** List this user's pending device-authorization requests (mock store; polled by the adapter). */
export async function GET() {
  return handleApi(async () => {
    if (!isEsignMock()) throw new ApiError(404, "Not found");
    const userId = await requireUserId();
    const rows = await prisma.esignPendingDevice.findMany({
      where: { userId },
      orderBy: { updatedAt: "asc" },
    });
    return NextResponse.json({ devices: rows.map((r) => JSON.parse(r.data)) });
  });
}
