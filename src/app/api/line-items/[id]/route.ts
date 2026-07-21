import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { updateLineItem } from "@/lib/claim-edits";

export const runtime = "nodejs";

const PatchSchema = z
  .object({
    description: z.string().min(1).max(300),
    amountCents: z.number().int(),
    ministry: z.string().max(100),
    event: z.string().max(100),
    isVerified: z.boolean(),
    isExcluded: z.boolean(),
  })
  .partial();

/**
 * Edit a line item during review (verify, exclude, adjust tax/amount, change
 * ministry, ...). Any content change un-verifies the row so the human must
 * re-approve it. The claim's total is recomputed on every change. The logic
 * lives in @/lib/claim-edits (shared with the MCP draft-help tools).
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid line item update", "invalidLineItemUpdate");

    const { lineItem, totalCents } = await updateLineItem(userId, id, parsed.data);
    return NextResponse.json({ lineItem, totalCents });
  });
}
