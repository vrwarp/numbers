import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { suggestForClaim } from "@/lib/claim-edits";

export const runtime = "nodejs";

const SuggestSchema = z.object({
  description: z.string().min(1).max(300),
  // Present only on the terminal "Something else…" follow-up: the user's extra
  // detail, plus the candidate categories they just rejected.
  more: z.string().min(1).max(300).optional(),
  rejected: z.array(z.string().max(120)).max(3).optional(),
});

/**
 * "Suggest": turn the user's one-sentence claim description into up to three
 * ranked, already-resolved ministry+event candidates. The AI may suggest,
 * never verify — nothing here touches line items; the UI shows the candidates
 * and the human applies one through the claim PATCH. The shared logic lives in
 * @/lib/claim-edits (also used by the MCP suggest-ministry tool).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const parsed = SuggestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Describe the claim in a sentence first", "descriptionRequired");

    const { candidates } = await suggestForClaim(userId, id, parsed.data);
    return NextResponse.json({ candidates });
  });
}
