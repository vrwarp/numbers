import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { isEsignMock } from "@/lib/config";

export const runtime = "nodejs";

/**
 * ESIGN_MOCK=1 ledger backend (docs/ESIGN_DESIGN.md §9.2 testing strategy):
 * an append-only event store with the SAME semantics the forked Firestore
 * rules enforce in production — any signed-in user may read ciphertext and
 * append; event ids are create-once; createdAt is server-stamped; nothing is
 * ever updated or deleted. Deliberately NOT tenant-scoped (mirrors the
 * world-readable/world-appendable rules; payloads are ciphertext).
 */

function requireMock() {
  if (!isEsignMock()) throw new ApiError(404, "Not found");
}

const LEDGER_ID = /^[A-Za-z0-9_-]{8,64}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{8,80}$/;

export async function GET(_req: Request, ctx: { params: Promise<{ ledgerId: string }> }) {
  return handleApi(async () => {
    requireMock();
    await requireUserId();
    const { ledgerId } = await ctx.params;
    if (!LEDGER_ID.test(ledgerId)) throw new ApiError(400, "Bad ledger id");
    const rows = await prisma.esignMockEvent.findMany({
      where: { ledgerId },
      orderBy: { id: "asc" },
    });
    return NextResponse.json({
      events: rows.map((r) => ({
        eventId: r.eventId,
        createdAtMs: r.createdAt.getTime(),
        encryptedData: r.encryptedData,
        iv: r.iv,
      })),
    });
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ ledgerId: string }> }) {
  return handleApi(async () => {
    requireMock();
    await requireUserId();
    const { ledgerId } = await ctx.params;
    if (!LEDGER_ID.test(ledgerId)) throw new ApiError(400, "Bad ledger id");
    const body = (await req.json().catch(() => ({}))) as { eventId?: string; encryptedData?: string; iv?: string };
    if (
      !body.eventId ||
      !EVENT_ID.test(body.eventId) ||
      typeof body.encryptedData !== "string" ||
      typeof body.iv !== "string" ||
      body.encryptedData.length > 200_000
    ) {
      throw new ApiError(400, "Bad event");
    }
    try {
      await prisma.esignMockEvent.create({
        data: {
          ledgerId,
          eventId: body.eventId,
          encryptedData: body.encryptedData,
          iv: body.iv,
        },
      });
    } catch {
      // Create-once: same as Firestore's create-on-existing-doc denial.
      throw new ApiError(409, "Event id already exists");
    }
    return NextResponse.json({ ok: true });
  });
}
