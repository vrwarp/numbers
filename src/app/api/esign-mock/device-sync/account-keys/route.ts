import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { isEsignMock } from "@/lib/config";

export const runtime = "nodejs";

/**
 * ESIGN_MOCK stand-in for charproof's per-user account-keys document
 * (docs/MULTI_DEVICE_PLAN.md M1/§5). The document is opaque client-encrypted
 * JSON (AMK keyring, device public keys, recovery wrappings); the `version`
 * counter gives compare-and-swap semantics standing in for Firestore
 * transactions. Deliberately NOT gated on the registry/master switch: in
 * production this collection lives in Firestore under charproof's own rules,
 * reachable regardless of numbers' e-sign switch.
 */

function requireMock() {
  if (!isEsignMock()) throw new ApiError(404, "Not found");
}

const MAX_DOC = 400_000;

function parseDoc(body: unknown): string {
  const doc = (body as { doc?: unknown }).doc;
  if (doc === undefined || doc === null) throw new ApiError(400, "Missing doc");
  const json = JSON.stringify(doc);
  if (json.length > MAX_DOC) throw new ApiError(400, "Document too large");
  return json;
}

export async function GET() {
  return handleApi(async () => {
    requireMock();
    const userId = await requireUserId();
    const row = await prisma.esignAccountKeys.findUnique({ where: { userId } });
    return NextResponse.json(
      row ? { doc: JSON.parse(row.doc), version: row.version } : { doc: null, version: 0 }
    );
  });
}

/** PUT — genesis create-if-absent (`create: true`) or plain overwrite (charproof setAccountKeys). */
export async function PUT(req: Request) {
  return handleApi(async () => {
    requireMock();
    const userId = await requireUserId();
    const body = (await req.json()) as { create?: boolean };
    const doc = parseDoc(body);
    if (body.create) {
      try {
        await prisma.esignAccountKeys.create({ data: { userId, doc } });
        return NextResponse.json({ created: true });
      } catch {
        // Unique violation: a concurrent genesis (other tab/device) won.
        return NextResponse.json({ created: false });
      }
    }
    await prisma.esignAccountKeys.upsert({
      where: { userId },
      create: { userId, doc },
      update: { doc, version: { increment: 1 } },
    });
    return NextResponse.json({ ok: true });
  });
}

/**
 * POST — compare-and-swap transaction. Body: { doc, baseVersion, pending? }.
 * `pending` optionally flips a pending-device row in the same transaction
 * (charproof transactApproveDevice). 409 on version conflict → client re-reads
 * and reruns its updater, matching Firestore transaction retry semantics.
 */
export async function POST(req: Request) {
  return handleApi(async () => {
    requireMock();
    const userId = await requireUserId();
    const body = (await req.json()) as {
      baseVersion?: number;
      pending?: { deviceId?: string; patch?: Record<string, unknown> };
    };
    const doc = parseDoc(body);
    if (typeof body.baseVersion !== "number") throw new ApiError(400, "Missing baseVersion");
    const pending = body.pending;
    if (pending && (typeof pending.deviceId !== "string" || typeof pending.patch !== "object")) {
      throw new ApiError(400, "Bad pending update");
    }

    await prisma.$transaction(async (tx) => {
      const updated = await tx.esignAccountKeys.updateMany({
        where: { userId, version: body.baseVersion },
        data: { doc, version: { increment: 1 } },
      });
      if (updated.count !== 1) throw new ApiError(409, "Version conflict — retry");
      if (pending) {
        const row = await tx.esignPendingDevice.findUnique({
          where: { userId_deviceId: { userId, deviceId: pending.deviceId! } },
        });
        if (row) {
          const merged = { ...JSON.parse(row.data), ...pending.patch };
          await tx.esignPendingDevice.update({
            where: { userId_deviceId: { userId, deviceId: pending.deviceId! } },
            data: { data: JSON.stringify(merged) },
          });
        }
      }
    });
    return NextResponse.json({ ok: true });
  });
}

/** DELETE — charproof resetRemoteStore (GDPR/start-over): purge this user's sync state. */
export async function DELETE() {
  return handleApi(async () => {
    requireMock();
    const userId = await requireUserId();
    await prisma.$transaction([
      prisma.esignAccountKeys.deleteMany({ where: { userId } }),
      prisma.esignPendingDevice.deleteMany({ where: { userId } }),
      prisma.esignKeystoreEntry.deleteMany({ where: { userId } }),
    ]);
    return NextResponse.json({ ok: true });
  });
}
