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
import { composeDescription } from "@/lib/ai/compose";
import { parseDollarsToCents } from "@/lib/money";
import type { ClaimStreamMessage } from "@/lib/claim-stream";

/**
 * Shared machinery for the two claim-building routes (create a claim, add
 * receipts to a draft): per-receipt AI extraction with all-or-nothing failure
 * handling, and the NDJSON progress-stream response. SERVER ONLY (prisma).
 */

export function extractionLogRow(
  userId: string,
  outcome: ReceiptExtraction,
  reimbursementId?: string
) {
  return {
    userId,
    reimbursementId,
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

export interface ClaimExtraction {
  /** Extraction fields to stamp onto the Receipt row. Absent when extraction
   *  failed and the row is a manual-entry placeholder — the receipt keeps
   *  whatever metadata it already had. */
  receiptUpdate?: {
    id: string;
    merchant: string;
    purchaseDate: string;
    extractedTotalCents: number;
    extractedRefundCents: number;
  };
  /** LineItem create data; sortOrder is the batch index — offset it when
   *  appending to a claim that already has rows. original* are null on a
   *  manual-entry row (the AI produced nothing to freeze), matching the
   *  "human-created row" convention used by splits. */
  item: {
    receiptId: string;
    description: string;
    amountCents: number;
    ministry: string;
    sortOrder: number;
    originalDescription: string | null;
    originalAmountCents: number | null;
  };
}

/**
 * Run each receipt through the LLM (one call per receipt, throttled to the RPM
 * target with quota-error retries) and map the results to row data.
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
 * and quota waits).
 */
export async function extractClaimRows(
  userId: string,
  receipts: Receipt[],
  onEvent?: ExtractionEventHandler
): Promise<{ outcomes: ReceiptExtraction[]; extractions: ClaimExtraction[] }> {
  const outcomes = await extractReceipts(receipts, onEvent);

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

  const extractions = outcomes.map((o, i): ClaimExtraction => {
    // Non-quota failure → a manual-entry placeholder the user fills in during
    // review. No receiptUpdate: the receipt keeps whatever metadata it had.
    if (o.result === null) {
      return {
        item: {
          receiptId: o.receipt.id,
          description: "",
          amountCents: 0,
          ministry: "",
          sortOrder: i,
          originalDescription: null,
          originalAmountCents: null,
        },
      };
    }
    const r = o.result;
    const totalCents = parseDollarsToCents(r.totalAmount);
    const refundCents = parseDollarsToCents(r.refundAmount);
    const description = composeDescription(r);
    return {
      receiptUpdate: {
        id: r.receiptId,
        merchant: r.merchant,
        purchaseDate: r.purchaseDate ?? "",
        extractedTotalCents: totalCents,
        extractedRefundCents: refundCents,
      },
      item: {
        receiptId: r.receiptId,
        description,
        // The suggested amount is a derivation of two printed numbers; the
        // review UI shows it ("charged X − refunded Y") for the human to
        // verify against what they actually paid.
        amountCents: totalCents - refundCents,
        // The model never assigns ministries; the user picks one per row
        // during review (a row cannot be verified without one).
        ministry: "",
        sortOrder: i,
        // Frozen AI snapshot for later original-vs-final comparison.
        originalDescription: description,
        originalAmountCents: totalCents - refundCents,
      },
    };
  });

  return { outcomes, extractions };
}

/**
 * Rows for a claim built WITHOUT any AI extraction — the manual escape hatch
 * for when the user would rather type receipts in than wait out a provider
 * rate-limit (or when extraction keeps failing). Every receipt gets the same
 * blank placeholder row a failed extraction produces, to fill in during review.
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
