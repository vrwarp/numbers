import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { isEsignMock } from "@/lib/config";

export const runtime = "nodejs";

/**
 * Single keystore entry (mock store). `docId` arrives already blinded by the
 * client (HMAC-style derivation from the AMK), and `entry` is AES-GCM
 * ciphertext under the AMK — the server stores opaque strings, exactly like
 * Firestore does in production.
 */

const DOC_ID = /^[A-Za-z0-9_-]{8,160}$/;

async function ctxEntry(ctx: { params: Promise<{ docId: string }> }) {
  if (!isEsignMock()) throw new ApiError(404, "Not found");
  const userId = await requireUserId();
  const { docId } = await ctx.params;
  if (!DOC_ID.test(docId)) throw new ApiError(400, "Bad keystore id");
  return { userId, docId };
}

export async function GET(_req: Request, ctx: { params: Promise<{ docId: string }> }) {
  return handleApi(async () => {
    const { userId, docId } = await ctxEntry(ctx);
    const row = await prisma.esignKeystoreEntry.findUnique({
      where: { userId_docId: { userId, docId } },
    });
    return NextResponse.json({ entry: row ? JSON.parse(row.entry) : null });
  });
}

export async function PUT(req: Request, ctx: { params: Promise<{ docId: string }> }) {
  return handleApi(async () => {
    const { userId, docId } = await ctxEntry(ctx);
    const body = (await req.json()) as { entry?: unknown };
    if (!body.entry) throw new ApiError(400, "Missing entry");
    const json = JSON.stringify(body.entry);
    if (json.length > 100_000) throw new ApiError(400, "Entry too large");
    await prisma.esignKeystoreEntry.upsert({
      where: { userId_docId: { userId, docId } },
      create: { userId, docId, entry: json },
      update: { entry: json },
    });
    return NextResponse.json({ ok: true });
  });
}

/** PATCH — archive flag merge (charproof setKeystoreArchivedStatus). */
export async function PATCH(req: Request, ctx: { params: Promise<{ docId: string }> }) {
  return handleApi(async () => {
    const { userId, docId } = await ctxEntry(ctx);
    const body = (await req.json()) as { isArchived?: unknown };
    if (typeof body.isArchived !== "boolean") throw new ApiError(400, "Missing isArchived");
    const row = await prisma.esignKeystoreEntry.findUnique({
      where: { userId_docId: { userId, docId } },
    });
    if (!row) throw new ApiError(404, "No such entry");
    const merged = { ...JSON.parse(row.entry), isArchived: body.isArchived };
    await prisma.esignKeystoreEntry.update({
      where: { userId_docId: { userId, docId } },
      data: { entry: JSON.stringify(merged) },
    });
    return NextResponse.json({ ok: true });
  });
}
