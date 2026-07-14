import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { suggestMinistryCandidates, SuggestionError, type SuggestionMeta } from "@/lib/ai/suggest";

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
 * and the human applies one through the claim PATCH (which is where fan-out,
 * un-verification and row audit events happen). Tapping a candidate is a pure
 * client apply; only "Something else…" (a body with `more`) calls the model a
 * second time. The description is persisted as the claim's note, and every
 * call is telemetry-logged (kind "suggestion") whether it succeeds or fails.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const parsed = SuggestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Describe the claim in a sentence first", "descriptionRequired");
    const description = parsed.data.description.trim();
    const refine = parsed.data.more
      ? { more: parsed.data.more.trim(), rejected: parsed.data.rejected ?? [] }
      : undefined;

    const claim = await prisma.reimbursement.findFirst({ where: { id, userId } });
    if (!claim) throw new ApiError(404, "Claim not found", "claimNotFound");
    if (claim.status !== "draft") {
      throw new ApiError(409, "Claim already generated; review settings are frozen", "claimSettingsFrozen");
    }

    if (description !== claim.claimDescription) {
      await prisma.$transaction([
        prisma.reimbursement.update({ where: { id }, data: { claimDescription: description } }),
        prisma.auditEvent.create({
          data: {
            userId,
            reimbursementId: id,
            action: "update-claim",
            detail: JSON.stringify({
              changes: { claimDescription: { from: claim.claimDescription, to: description } },
            }),
          },
        }),
      ]);
    }

    const logSuggestion = (meta: SuggestionMeta, parsedJson: string | null, error: string | null) =>
      prisma.extractionLog.create({
        data: {
          userId,
          reimbursementId: id,
          kind: "suggestion",
          model: meta.model,
          prompt: meta.prompt,
          receiptsJson: null,
          rawResponse: meta.rawResponse,
          parsedJson,
          status: error ? "error" : "success",
          errorMessage: error,
          durationMs: meta.durationMs,
        },
      });

    try {
      const { candidates, meta } = await suggestMinistryCandidates(description, refine);
      await logSuggestion(meta, JSON.stringify({ candidates }), null);
      return NextResponse.json({ candidates });
    } catch (err) {
      if (err instanceof SuggestionError) {
        await logSuggestion(err.meta, null, err.message);
        throw new ApiError(
          err.quota ? 429 : 502,
          err.quota
            ? "The AI provider is rate-limited right now — try again in a minute or pick a ministry manually"
            : "The AI couldn't produce a suggestion — pick a ministry manually",
          err.quota ? "aiRateLimited" : "aiNoSuggestion"
        );
      }
      throw err;
    }
  });
}
