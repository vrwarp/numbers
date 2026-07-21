import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api";
import { computeLineItemChanges, type ChangeSet } from "@/lib/audit";
import { mostCommonMinistryEvent } from "@/lib/ministries";
import { suggestMinistryCandidates, SuggestionError, type SuggestionMeta } from "@/lib/ai/suggest";
import { enqueueClaimEmbeddingDebounced } from "@/lib/embeddings/queue";

/**
 * The draft-editing operations shared by the review-screen API routes and the
 * MCP draft-help tools (docs/MCP_DESIGN.md): claim-level settings, single
 * line-item edits, and AI ministry suggestions. SERVER ONLY (prisma). Each
 * takes an explicit `userId`, owns-checks its target (404 on any miss), refuses
 * non-draft claims (409), and keeps the audit/embedding trail intact
 * (invariants 4/5/7/11). They throw `ApiError`; callers surface the code.
 */

export interface ClaimSettingsPatch {
  singleMinistry?: boolean;
  claimMinistry?: string;
  claimEvent?: string;
  claimDescription?: string;
}

/**
 * Edit a draft claim's review settings. In single-ministry mode the claim's
 * ministry/event MIRROR onto every non-excluded row (each fanned-out row is
 * un-verified and audited individually — a content change always needs
 * re-approval). Switching multi → single without an explicit claimMinistry
 * adopts the most common (ministry, event) pair among the active rows.
 */
export async function updateClaimSettings(
  userId: string,
  id: string,
  patch: ClaimSettingsPatch
): Promise<void> {
  const claim = await prisma.reimbursement.findFirst({
    where: { id, userId },
    include: { lineItems: true },
  });
  if (!claim) throw new ApiError(404, "Claim not found", "claimNotFound");
  if (claim.status !== "draft") {
    throw new ApiError(409, "Claim already generated; review settings are frozen", "claimSettingsFrozen");
  }

  const singleMinistry = patch.singleMinistry ?? claim.singleMinistry;
  const enablingSingle = singleMinistry && !claim.singleMinistry;

  // Multi → single with no explicit value: adopt what most rows already say.
  const adopted =
    enablingSingle && patch.claimMinistry === undefined
      ? mostCommonMinistryEvent(claim.lineItems)
      : null;
  const claimMinistry = patch.claimMinistry ?? adopted?.ministry ?? claim.claimMinistry;
  const claimEvent = patch.claimEvent ?? adopted?.event ?? claim.claimEvent;
  const claimDescription = patch.claimDescription ?? claim.claimDescription;

  // Mirror onto rows only when single mode is (still or newly) on and the
  // mirrored values were actually touched by this patch.
  const fanOut =
    singleMinistry &&
    (enablingSingle ||
      patch.claimMinistry !== undefined ||
      patch.claimEvent !== undefined ||
      adopted !== null);
  const rowWrites = fanOut
    ? claim.lineItems
        .filter((it) => !it.isExcluded && (it.ministry !== claimMinistry || it.event !== claimEvent))
        .map((it) => ({
          id: it.id,
          changes: computeLineItemChanges(it, {
            ministry: claimMinistry,
            event: claimEvent,
            // Content changed, so the human must re-approve the row.
            isVerified: false,
          }),
        }))
    : [];

  const claimChanges: ChangeSet = {};
  for (const field of ["singleMinistry", "claimMinistry", "claimEvent", "claimDescription"] as const) {
    const to = { singleMinistry, claimMinistry, claimEvent, claimDescription }[field];
    if (claim[field] !== to) claimChanges[field] = { from: claim[field], to };
  }

  await prisma.$transaction([
    prisma.reimbursement.update({
      where: { id },
      data: { singleMinistry, claimMinistry, claimEvent, claimDescription },
    }),
    ...rowWrites.map((w) =>
      prisma.lineItem.update({
        where: { id: w.id },
        data: { ministry: claimMinistry, event: claimEvent, isVerified: false },
      })
    ),
    // One audit event per changed row (same trail as a manual row edit),
    // plus one for the claim-level settings themselves.
    ...rowWrites
      .filter((w) => Object.keys(w.changes).length > 0)
      .map((w) =>
        prisma.auditEvent.create({
          data: {
            userId,
            reimbursementId: id,
            lineItemId: w.id,
            action: "update",
            detail: JSON.stringify({ changes: w.changes, source: "claim-ministry" }),
          },
        })
      ),
    ...(Object.keys(claimChanges).length > 0
      ? [
          prisma.auditEvent.create({
            data: {
              userId,
              reimbursementId: id,
              action: "update-claim",
              detail: JSON.stringify({ changes: claimChanges }),
            },
          }),
        ]
      : []),
  ]);

  // Draft content changed → debounced re-index (docs/SEARCH_DESIGN.md §5.2).
  enqueueClaimEmbeddingDebounced(id, userId);
}

export interface LineItemPatch {
  description?: string;
  amountCents?: number;
  ministry?: string;
  event?: string;
  isVerified?: boolean;
  isExcluded?: boolean;
}

/**
 * Edit one line item on a draft claim. Any content change un-verifies the row
 * (invariant 4); verifying requires a non-empty ministry (invariant 3 — the AI
 * never assigns one, so a human must); the claim total is recomputed every time
 * (invariant 5). Returns the updated row and the new total.
 */
export async function updateLineItem(
  userId: string,
  id: string,
  patch: LineItemPatch
): Promise<{ lineItem: Awaited<ReturnType<typeof prisma.lineItem.update>>; totalCents: number }> {
  const item = await prisma.lineItem.findFirst({
    where: { id, reimbursement: { userId } },
    include: {
      reimbursement: {
        select: { status: true, id: true, singleMinistry: true, claimMinistry: true, claimEvent: true },
      },
    },
  });
  if (!item) throw new ApiError(404, "Line item not found", "lineItemNotFound");
  if (item.reimbursement.status !== "draft") {
    throw new ApiError(409, "Claim already generated; line items are frozen", "claimFrozen");
  }
  // A row restored in single-ministry mode missed any fan-out that happened
  // while it was excluded — stamp it back to the claim's ministry/event. This
  // must run BEFORE the verify gate: restore + verify in one call is legit, and
  // the stamped ministry is what satisfies the gate.
  if (patch.isExcluded === false && item.isExcluded && item.reimbursement.singleMinistry) {
    if (patch.ministry === undefined) patch.ministry = item.reimbursement.claimMinistry;
    if (patch.event === undefined) patch.event = item.reimbursement.claimEvent;
  }
  // Verification is an explicit human sign-off, and the ministry is part of it.
  // Trim so a whitespace-only ministry can't satisfy the gate and then print as
  // a blank column on the official form.
  const effectiveMinistry = (patch.ministry ?? item.ministry).trim();
  if (patch.isVerified === true && !effectiveMinistry) {
    throw new ApiError(400, "Choose a ministry before verifying this row", "ministryRequiredToVerify");
  }

  const changes = computeLineItemChanges(item, patch);
  const contentChanged = ["description", "amountCents", "ministry", "event"].some((f) => f in changes);
  // Fold the implicit re-verification revocation into the patch so the audit
  // trail records the isVerified true→false flip a content edit triggers
  // (invariant 4).
  if (contentChanged && patch.isVerified === undefined && item.isVerified) {
    patch.isVerified = false;
    Object.assign(changes, computeLineItemChanges(item, { isVerified: false }));
  }

  const updated = await prisma.lineItem.update({ where: { id }, data: patch });

  if (Object.keys(changes).length > 0) {
    await prisma.auditEvent.create({
      data: {
        userId,
        reimbursementId: item.reimbursement.id,
        lineItemId: id,
        action: "update",
        detail: JSON.stringify({ changes }),
      },
    });
  }

  const items = await prisma.lineItem.findMany({ where: { reimbursementId: item.reimbursement.id } });
  const totalCents = items.reduce((s, it) => (it.isExcluded ? s : s + it.amountCents), 0);
  await prisma.reimbursement.update({ where: { id: item.reimbursement.id }, data: { totalCents } });

  enqueueClaimEmbeddingDebounced(item.reimbursement.id, userId);
  return { lineItem: updated, totalCents };
}

export interface SuggestInput {
  description: string;
  more?: string;
  rejected?: string[];
}

/**
 * Turn a draft claim's one-sentence description into up to three ranked,
 * already-resolved ministry+event candidates. The AI may suggest, never verify
 * — nothing here touches line items; a human applies a candidate through
 * updateClaimSettings (where fan-out/un-verification/audit happen). The
 * description is persisted as the claim's note, and every call is
 * telemetry-logged (kind "suggestion") whether it succeeds or fails.
 */
export async function suggestForClaim(
  userId: string,
  id: string,
  input: SuggestInput
): Promise<{ candidates: Awaited<ReturnType<typeof suggestMinistryCandidates>>["candidates"] }> {
  const description = input.description.trim();
  const refine = input.more ? { more: input.more.trim(), rejected: input.rejected ?? [] } : undefined;

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
    // claimDescription is part of the embedding composite (§5.2 / invariant 11).
    enqueueClaimEmbeddingDebounced(id, userId);
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
    return { candidates };
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
}
