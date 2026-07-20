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
import type { ClaimStreamMessage } from "@/lib/claim-stream";

export type { ClaimExtraction } from "@/lib/claims-rows";

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
