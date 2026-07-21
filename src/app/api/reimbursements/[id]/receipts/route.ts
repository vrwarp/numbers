import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Receipt } from "@prisma/client";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import {
  addReceiptsToClaim,
  apiErrorJson,
  claimProgressStream,
  resolveReceiptsToAdd,
  type ExtractMode,
} from "@/lib/claims";

export const runtime = "nodejs";
// Same budget as claim creation: extraction can sit through quota cooldowns.
export const maxDuration = 900;

const AddSchema = z.object({
  receiptIds: z.array(z.string().min(1)).min(1),
  // Skip AI extraction and start with blank rows — the manual escape hatch.
  manual: z.boolean().optional(),
});

/** Own-check the claim (draft only) and the receipts to add, or throw. */
async function loadValidated(req: NextRequest, userId: string, id: string) {
  const body = AddSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) throw new ApiError(400, "receiptIds (non-empty array) required", "receiptIdsRequired");
  // As at claim creation, any owned receipt qualifies regardless of status —
  // a receipt may sit on several claims. Its stored background annotation is
  // consumed as-is; only never-annotated receipts are extracted here.
  const receipts = await resolveReceiptsToAdd(userId, id, body.data.receiptIds);
  return { receipts, mode: body.data.manual ? ("manual" as ExtractMode) : ("ai" as ExtractMode) };
}

/**
 * Add receipts to an existing DRAFT claim ("I forgot one"). Body
 * `{receiptIds[]}`; receipts already on the claim are refused (409), as is a
 * generated claim. Same two response shapes as claim creation: plain JSON
 * `{ok, totalCents}`, or an NDJSON progress stream when the client sends
 * `Accept: application/x-ndjson` (final line `{type:"done"}` carries the
 * claim id for symmetry with create).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const wantsStream = req.headers.get("accept")?.includes("application/x-ndjson") ?? false;
  const { id } = await ctx.params;

  if (!wantsStream) {
    return handleApi(async () => {
      const userId = await requireUserId();
      const { receipts, mode } = await loadValidated(req, userId, id);
      const totalCents = await addReceiptsToClaim(userId, id, receipts, mode);
      return NextResponse.json({ ok: true, totalCents });
    });
  }

  let userId: string;
  let receipts: Receipt[];
  let mode: ExtractMode;
  try {
    userId = await requireUserId();
    ({ receipts, mode } = await loadValidated(req, userId, id));
  } catch (err) {
    return apiErrorJson(err);
  }

  return claimProgressStream(receipts.length, async (onEvent) => {
    await addReceiptsToClaim(userId, id, receipts, mode, onEvent);
    return { reimbursementId: id };
  });
}
