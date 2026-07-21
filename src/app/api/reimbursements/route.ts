import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Receipt } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import {
  apiErrorJson,
  claimProgressStream,
  createDraftClaim,
  resolveClaimReceipts,
  type ExtractMode,
} from "@/lib/claims";

export const runtime = "nodejs";
// Per-receipt AI extraction on a large claim can take a while — especially
// when quota errors trigger ~60s cooldown-and-retry cycles (AI_QUOTA_*).
export const maxDuration = 900;

export async function GET() {
  return handleApi(async () => {
    const userId = await requireUserId();
    const reimbursements = await prisma.reimbursement.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { lineItems: true, receipts: true } } },
    });
    return NextResponse.json({ reimbursements });
  });
}

const CreateSchema = z.object({
  receiptIds: z.array(z.string().min(1)).min(1),
  // Skip AI extraction and start with blank rows — the manual escape hatch.
  manual: z.boolean().optional(),
});

/** Parse + own-check the selected receipts, or throw the right ApiError. */
async function loadSelectedReceipts(
  req: NextRequest,
  userId: string
): Promise<{ receipts: Receipt[]; mode: ExtractMode }> {
  const body = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) throw new ApiError(400, "receiptIds (non-empty array) required", "receiptIdsRequired");
  // A receipt may go on any number of claims (e.g. one purchase split across
  // two filings) — processed receipts are deliberately allowed. Its stored
  // annotation (normally written by the background worker soon after upload)
  // is reused as-is; only never-annotated receipts are extracted here.
  const receipts = await resolveClaimReceipts(userId, body.data.receiptIds);
  return { receipts, mode: body.data.manual ? "manual" : "ai" };
}

/**
 * "Generate Claim": extract each selected receipt and create a draft claim.
 *
 * Two response shapes, chosen by the Accept header:
 *   - `application/x-ndjson` → a stream of newline-delimited progress events
 *     (status, per-receipt completion, quota-wait notices) ending in a
 *     `done`/`error` line. The Shoebox UI uses this to show live status.
 *   - anything else → the classic JSON `{ reimbursement }` with 201 (or a JSON
 *     error), which is what the programmatic API and tests rely on.
 */
export async function POST(req: NextRequest) {
  const wantsStream = req.headers.get("accept")?.includes("application/x-ndjson") ?? false;

  if (!wantsStream) {
    return handleApi(async () => {
      const userId = await requireUserId();
      const { receipts, mode } = await loadSelectedReceipts(req, userId);
      const reimbursement = await createDraftClaim(userId, receipts, mode);
      return NextResponse.json({ reimbursement }, { status: 201 });
    });
  }

  // Streaming path: auth/validation errors still come back as plain JSON (the
  // client reads them before switching to stream mode); the extraction phase
  // streams NDJSON with HTTP 200 and carries any failure in the final line.
  let userId: string;
  let receipts: Receipt[];
  let mode: ExtractMode;
  try {
    userId = await requireUserId();
    ({ receipts, mode } = await loadSelectedReceipts(req, userId));
  } catch (err) {
    return apiErrorJson(err);
  }

  return claimProgressStream(receipts.length, async (onEvent) => {
    const reimbursement = await createDraftClaim(userId, receipts, mode, onEvent);
    return { reimbursementId: reimbursement.id };
  });
}
