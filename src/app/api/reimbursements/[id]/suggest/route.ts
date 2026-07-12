import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { suggestMinistryEvent, SuggestionError, type SuggestionMeta } from "@/lib/ai/suggest";

export const runtime = "nodejs";

const SuggestSchema = z.object({
  description: z.string().min(1).max(300),
});

/**
 * "Suggest": turn the user's one-sentence claim description into a proposed
 * ministry + event. The AI may suggest, never verify — nothing here touches
 * line items; the UI shows the suggestion and the human applies it through
 * the claim PATCH (which is where fan-out, un-verification and row audit
 * events happen). The description is persisted as the claim's note, and the
 * call is telemetry-logged (kind "suggestion") whether it succeeds or fails.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const parsed = SuggestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Describe the claim in a sentence first", "descriptionRequired");
    const description = parsed.data.description.trim();

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
      const { suggestion, meta } = await suggestMinistryEvent(description);
      await logSuggestion(meta, JSON.stringify(suggestion), null);
      return NextResponse.json({ suggestion });
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
