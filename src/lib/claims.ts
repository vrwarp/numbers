import { NextResponse } from "next/server";
import type { Receipt } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, apiErrorPayload } from "@/lib/api";
import {
  extractReceipts,
  type ReceiptExtraction,
  type ExtractionEventHandler,
} from "@/lib/ai/extract";
import { isQuotaErrorMessage } from "@/lib/ai/throttle";
import { rpmTarget } from "@/lib/config";
import {
  annotationClaimRow,
  isAnnotated,
  outcomeClaimRow,
  type ClaimExtraction,
} from "@/lib/claims-rows";
import { completeAnnotationJobs } from "@/lib/extraction/queue";
import { enqueueReceiptEmbedding, enqueueClaimEmbeddingDebounced } from "@/lib/embeddings/queue";
import type { ClaimStreamMessage } from "@/lib/claim-stream";

export type { ClaimExtraction } from "@/lib/claims-rows";

/**
 * How a claim-building call sources its rows:
 *  - `ai`     — consume stored annotations, AI-extract the rest (the app UI's
 *               default; may call the provider and cost quota).
 *  - `manual` — ignore annotations, every row blank (the UI's manual escape
 *               hatch, and no provider call).
 *  - `stored` — consume stored annotations, blank for the not-yet-annotated —
 *               NEVER call the provider. The MCP default (docs/MCP_DESIGN.md):
 *               an assistant drafting a claim gets the background worker's
 *               already-extracted data with no surprise AI latency or quota.
 */
export type ExtractMode = "ai" | "manual" | "stored";

/** The blank manual-entry row a receipt gets when nothing has been extracted
 *  for it — the same placeholder a failed extraction produces. */
function blankRow(receiptId: string, sortOrder: number): ClaimExtraction {
  return {
    item: {
      receiptId,
      description: "",
      amountCents: 0,
      ministry: "",
      sortOrder,
      originalDescription: null,
      originalAmountCents: null,
    },
  };
}

/** Build one row per receipt per the chosen mode. `ai` delegates to
 *  extractClaimRows (provider calls + telemetry outcomes); the other two are
 *  pure and make no provider call, so they carry no outcomes. */
async function buildClaimRows(
  userId: string,
  receipts: Receipt[],
  mode: ExtractMode,
  onEvent?: ExtractionEventHandler
): Promise<{ outcomes: ReceiptExtraction[]; extractions: ClaimExtraction[] }> {
  if (mode === "manual") return { outcomes: [], extractions: manualClaimRows(receipts) };
  if (mode === "stored") {
    return {
      outcomes: [],
      extractions: receipts.map((r, i) => (isAnnotated(r) ? annotationClaimRow(r, i) : blankRow(r.id, i))),
    };
  }
  return extractClaimRows(userId, receipts, onEvent);
}

/**
 * Shared machinery for the two claim-building routes (create a claim, add
 * receipts to a draft): consuming stored background annotations, per-receipt
 * AI extraction for the receipts the worker hasn't reached, and the NDJSON
 * progress-stream response. SERVER ONLY (prisma).
 */

export function extractionLogRow(
  userId: string,
  outcome: ReceiptExtraction,
  reimbursementId?: string
) {
  return {
    userId,
    reimbursementId,
    receiptId: outcome.receipt.id,
    model: outcome.meta.model,
    prompt: outcome.meta.prompt,
    receiptsJson: outcome.meta.receiptsJson,
    rawResponse: outcome.meta.rawResponse,
    parsedJson: outcome.result ? JSON.stringify(outcome.result) : null,
    status: outcome.error ? "error" : "success",
    errorMessage: outcome.error,
    durationMs: outcome.meta.durationMs,
  };
}

/**
 * Build one row per receipt, in the selection order. Receipts the background
 * worker (or a human, via manual entry) already annotated are consumed
 * DIRECTLY from the Receipt columns — no AI call, they complete instantly.
 * Only the rest go through the LLM (one call per receipt, throttled to the
 * RPM target with quota-error retries), and each success also stamps the
 * receipt's annotation so the NEXT claim skips the call too.
 *
 * A receipt the model can't read (a blurry photo, or something that isn't a
 * receipt at all) does NOT block the batch: its outcome becomes a blank
 * MANUAL-ENTRY row (empty description, $0, no ministry, null original*) with no
 * receiptUpdate, which the user completes in review via the manual-entry
 * dialog. The human-in-the-loop gate still holds — the row is unverified with
 * no ministry, so it can't reach the PDF untouched.
 *
 * The exception is a quota / rate-limit failure: it is transient and
 * batch-wide, so those stay all-or-nothing — every call is telemetry-logged
 * and a 429 is thrown so the caller can retry the whole batch, rather than
 * littering the claim with manual rows for receipts that would have read fine a
 * minute later.
 *
 * On the success/partial path the outcomes are returned UNlogged so the caller
 * can log them (successes AND failures) with the claim id after its transaction
 * commits. onEvent forwards live extraction progress (per-receipt completion
 * and quota waits); consumed annotations surface as immediate completions so
 * the stream's counts stay truthful.
 */
export async function extractClaimRows(
  userId: string,
  receipts: Receipt[],
  onEvent?: ExtractionEventHandler
): Promise<{ outcomes: ReceiptExtraction[]; extractions: ClaimExtraction[] }> {
  const annotated = receipts.filter((r) => isAnnotated(r));
  const pending = receipts.filter((r) => !isAnnotated(r));

  annotated.forEach((r, i) => {
    onEvent?.({
      type: "receipt-done",
      receiptId: r.id,
      receiptName: r.originalName,
      ok: true,
      completed: i + 1,
      total: receipts.length,
    });
  });

  // Live-extraction events count only the pending subset — offset them so the
  // stream keeps reporting progress over the WHOLE selection.
  const offsetEvent: ExtractionEventHandler | undefined = onEvent
    ? (ev) =>
        onEvent(
          ev.type === "receipt-done"
            ? { ...ev, completed: ev.completed + annotated.length, total: receipts.length }
            : ev
        )
    : undefined;

  const outcomes =
    pending.length > 0 ? await extractReceipts(pending, offsetEvent) : [];

  // Quota / rate-limit failures are transient and batch-wide — keep them
  // all-or-nothing so the user retries rather than getting manual rows for
  // receipts that would have read fine. Log every call first: we throw here
  // before the caller gets a chance to.
  const quotaFailed = outcomes.filter(
    (o) =>
      o.result === null &&
      (isQuotaErrorMessage(o.error) || isQuotaErrorMessage(o.meta.rawResponse))
  );
  if (quotaFailed.length > 0) {
    await prisma.extractionLog.createMany({
      data: outcomes.map((o) => extractionLogRow(userId, o)),
    });
    const names = quotaFailed.map((f) => f.receipt.originalName).join(", ");
    throw new ApiError(
      429,
      `The AI provider is busy right now — please wait a minute and try again. Affected: ${names}`,
      "aiQuotaExhausted",
      { rpm: rpmTarget(), names }
    );
  }

  const outcomeByReceipt = new Map(outcomes.map((o) => [o.receipt.id, o]));
  const extractions = receipts.map((r, i) =>
    isAnnotated(r) ? annotationClaimRow(r, i) : outcomeClaimRow(outcomeByReceipt.get(r.id)!, i)
  );

  return { outcomes, extractions };
}

/**
 * Post-commit bookkeeping shared by the claim-building routes (non-manual
 * path only — manual mode consumes nothing and calls nothing):
 *  - log every fresh AI call against the claim (invariant 7);
 *  - adopt the batch's still-unlinked background-annotation logs, so the
 *    claim's telemetry shows the calls that actually produced its rows even
 *    though they ran before the claim existed;
 *  - mark the freshly-extracted receipts' queue jobs done, so the background
 *    worker doesn't re-read what the claim just read.
 * Never throws: the claim exists — telemetry/queue upkeep must not fail it.
 */
export async function recordClaimExtractions(
  userId: string,
  reimbursementId: string,
  receipts: Receipt[],
  outcomes: ReceiptExtraction[]
): Promise<void> {
  try {
    if (outcomes.length > 0) {
      await prisma.extractionLog.createMany({
        data: outcomes.map((o) => extractionLogRow(userId, o, reimbursementId)),
      });
    }
    await prisma.extractionLog.updateMany({
      where: {
        userId,
        kind: "receipt",
        reimbursementId: null,
        receiptId: { in: receipts.map((r) => r.id) },
      },
      data: { reimbursementId },
    });
    completeAnnotationJobs(
      outcomes.filter((o) => o.result !== null).map((o) => o.receipt.id)
    );
  } catch (err) {
    console.error("claim extraction bookkeeping failed:", err);
  }
}

/**
 * Rows for a claim built WITHOUT any AI extraction — the manual escape hatch
 * for when the user would rather type receipts in than wait out a provider
 * rate-limit (or when extraction keeps failing). Every receipt gets the same
 * blank placeholder row a failed extraction produces, to fill in during review
 * — stored annotations are deliberately ignored: manual means manual.
 * No provider calls are made, so there are no outcomes to telemetry-log.
 */
export function manualClaimRows(receipts: Receipt[]): ClaimExtraction[] {
  return receipts.map((r, i) => ({
    item: {
      receiptId: r.id,
      description: "",
      amountCents: 0,
      ministry: "",
      sortOrder: i,
      originalDescription: null,
      originalAmountCents: null,
    },
  }));
}

/** Resolve + own-check receipts by id for a NEW claim, or throw. A receipt may
 *  sit on any number of claims, so status is not checked here. */
export async function resolveClaimReceipts(userId: string, receiptIds: string[]): Promise<Receipt[]> {
  const ids = [...new Set(receiptIds)];
  const receipts = await prisma.receipt.findMany({ where: { id: { in: ids }, userId } });
  if (receipts.length !== ids.length) {
    throw new ApiError(404, "One or more receipts were not found", "receiptsNotFound");
  }
  return receipts;
}

/**
 * Build a draft claim from already-resolved receipts (the shared core behind
 * POST /api/reimbursements and the MCP create-draft tool). Consumes each
 * receipt's stored annotation per `mode`, creates the Reimbursement (status
 * "draft") with its receipt joins and one line item per receipt in a single
 * transaction, recomputes the total, keeps the telemetry/embedding trail
 * (invariants 7/11), and returns the created claim (with its line items).
 */
export async function createDraftClaim(
  userId: string,
  receipts: Receipt[],
  mode: ExtractMode,
  onEvent?: ExtractionEventHandler
) {
  const { outcomes, extractions } = await buildClaimRows(userId, receipts, mode, onEvent);
  const items = extractions.map((e) => e.item);
  const totalCents = items.reduce((s, it) => s + it.amountCents, 0);

  const claimDescription = receipts.length === 1 ? (receipts[0].note || "") : "";

  const receiptIds = receipts.map((r) => r.id);
  const [reimbursement] = await prisma.$transaction([
    prisma.reimbursement.create({
      data: {
        userId,
        totalCents,
        claimDescription,
        receipts: { create: receiptIds.map((receiptId) => ({ receiptId })) },
        lineItems: { create: items },
      },
      include: { lineItems: true },
    }),
    ...extractions
      .filter((e) => e.receiptUpdate)
      .map(({ receiptUpdate }) => {
        const { id, ...data } = receiptUpdate!;
        return prisma.receipt.update({ where: { id }, data });
      }),
  ]);

  // Manual mode consumes/calls nothing; ai and stored both adopt the batch's
  // background-annotation logs so the claim's telemetry is complete.
  if (mode !== "manual") await recordClaimExtractions(userId, reimbursement.id, receipts, outcomes);

  enqueueClaimEmbeddingDebounced(reimbursement.id, userId);
  for (const e of extractions) {
    if (e.receiptUpdate) enqueueReceiptEmbedding(e.receiptUpdate.id, userId);
  }

  return reimbursement;
}

/** Resolve + validate receipts to ADD to an existing draft, or throw (draft
 *  gate, duplicate gate, ownership). */
export async function resolveReceiptsToAdd(
  userId: string,
  claimId: string,
  receiptIds: string[]
): Promise<Receipt[]> {
  const ids = [...new Set(receiptIds)];
  const reimbursement = await prisma.reimbursement.findFirst({
    where: { id: claimId, userId },
    include: { receipts: { select: { receiptId: true } } },
  });
  if (!reimbursement) throw new ApiError(404, "Claim not found", "claimNotFound");
  if (reimbursement.status !== "draft") {
    throw new ApiError(409, "Claim already generated; receipts are frozen", "claimReceiptsFrozen");
  }
  if (ids.some((rid) => reimbursement.receipts.some((rr) => rr.receiptId === rid))) {
    throw new ApiError(409, "One or more receipts are already on this claim", "receiptsAlreadyOnClaim");
  }
  const receipts = await prisma.receipt.findMany({ where: { id: { in: ids }, userId } });
  if (receipts.length !== ids.length) {
    throw new ApiError(404, "One or more receipts were not found", "receiptsNotFound");
  }
  return receipts;
}

/**
 * Append already-resolved receipts to a DRAFT claim (the shared core behind
 * POST /api/reimbursements/[id]/receipts and the MCP add-receipts tool): one
 * line item per receipt per `mode`, sorted after existing rows, inheriting the
 * claim's ministry/event in single-ministry mode, with an AuditEvent and a
 * fresh total recompute. Re-checks the draft gate after any extraction (which
 * can take minutes). Returns the new totalCents.
 */
export async function addReceiptsToClaim(
  userId: string,
  reimbursementId: string,
  receipts: Receipt[],
  mode: ExtractMode,
  onEvent?: ExtractionEventHandler
): Promise<number> {
  const { outcomes, extractions } = await buildClaimRows(userId, receipts, mode, onEvent);

  const current = await prisma.reimbursement.findFirst({
    where: { id: reimbursementId, userId },
    include: { lineItems: { select: { sortOrder: true } } },
  });
  if (!current) throw new ApiError(404, "Claim not found", "claimNotFound");
  if (current.status !== "draft") {
    throw new ApiError(409, "Claim already generated; receipts are frozen", "claimReceiptsFrozen");
  }

  const sortOrderStart = current.lineItems.reduce((m, it) => Math.max(m, it.sortOrder), -1) + 1;
  const items = extractions.map((e) => ({
    ...e.item,
    sortOrder: sortOrderStart + e.item.sortOrder,
    ...(current.singleMinistry
      ? { ministry: current.claimMinistry, event: current.claimEvent }
      : {}),
  }));

  await prisma.$transaction([
    prisma.reimbursement.update({
      where: { id: reimbursementId },
      data: {
        receipts: { create: receipts.map((r) => ({ receiptId: r.id })) },
        lineItems: { create: items },
      },
    }),
    ...extractions
      .filter((e) => e.receiptUpdate)
      .map(({ receiptUpdate }) => {
        const { id, ...data } = receiptUpdate!;
        return prisma.receipt.update({ where: { id }, data });
      }),
    prisma.auditEvent.create({
      data: {
        userId,
        reimbursementId,
        action: "add-receipt",
        detail: JSON.stringify({
          addedReceipts: items.map((it) => ({
            receiptId: it.receiptId,
            originalName: receipts.find((r) => r.id === it.receiptId)?.originalName ?? "",
            description: it.description,
            amountCents: it.amountCents,
          })),
        }),
      },
    }),
  ]);

  const all = await prisma.lineItem.findMany({ where: { reimbursementId } });
  const totalCents = all.reduce((s, it) => (it.isExcluded ? s : s + it.amountCents), 0);
  await prisma.reimbursement.update({ where: { id: reimbursementId }, data: { totalCents } });

  if (mode !== "manual") await recordClaimExtractions(userId, reimbursementId, receipts, outcomes);

  enqueueClaimEmbeddingDebounced(reimbursementId, userId);
  for (const e of extractions) {
    if (e.receiptUpdate) enqueueReceiptEmbedding(e.receiptUpdate.id, userId);
  }

  return totalCents;
}

/** Pre-stream (auth/validation) failures still return plain JSON — the client
 *  reads them before switching to stream mode. */
export function apiErrorJson(err: unknown): NextResponse {
  const { body, status } = apiErrorPayload(err);
  return NextResponse.json(body, { status });
}

/**
 * NDJSON progress response for a claim-building extraction: a leading status
 * line, live extraction events, then a final done/error line (HTTP is 200
 * either way — the failure travels in the last line).
 */
export function claimProgressStream(
  total: number,
  work: (onEvent: ExtractionEventHandler) => Promise<{ reimbursementId: string }>
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (msg: ClaimStreamMessage) =>
        controller.enqueue(encoder.encode(JSON.stringify(msg) + "\n"));
      try {
        send({ type: "status", phase: "extracting", total });
        const { reimbursementId } = await work((ev) => send(ev));
        send({ type: "done", reimbursementId });
      } catch (err) {
        if (!(err instanceof ApiError)) console.error("Claim extraction error:", err);
        send({
          type: "error",
          status: err instanceof ApiError ? err.status : 500,
          message: err instanceof Error ? err.message : "Claim generation failed",
          ...(err instanceof ApiError && err.code ? { code: err.code, params: err.params } : {}),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
