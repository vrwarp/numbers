import { NextResponse } from "next/server";
import type { Receipt } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api";
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
  /** Extraction fields to stamp onto the Receipt row. */
  receiptUpdate: {
    id: string;
    merchant: string;
    purchaseDate: string;
    extractedTotalCents: number;
    extractedRefundCents: number;
  };
  /** LineItem create data; sortOrder is the batch index — offset it when
   *  appending to a claim that already has rows. */
  item: {
    receiptId: string;
    description: string;
    amountCents: number;
    ministry: string;
    sortOrder: number;
    originalDescription: string;
    originalAmountCents: number;
  };
}

/**
 * Run each receipt through the LLM (one call per receipt, throttled to the RPM
 * target with quota-error retries) and map the results to row data.
 * All-or-nothing: if any receipt fails to extract, every call is
 * telemetry-logged and the matching ApiError is thrown — no rows for the
 * caller to write. On success the outcomes are returned UNlogged so the caller
 * can log them with the claim id after its transaction commits. onEvent
 * forwards live extraction progress (per-receipt completion and quota waits).
 */
export async function extractClaimRows(
  userId: string,
  receipts: Receipt[],
  onEvent?: ExtractionEventHandler
): Promise<{ outcomes: ReceiptExtraction[]; extractions: ClaimExtraction[] }> {
  const outcomes = await extractReceipts(receipts, onEvent);

  const failed = outcomes.filter((o) => o.result === null);
  if (failed.length > 0) {
    // Failed calls are logged too — bad model output is prompt-tuning gold.
    await prisma.extractionLog.createMany({
      data: outcomes.map((o) => extractionLogRow(userId, o)),
    });
    const names = failed.map((f) => f.receipt.originalName).join(", ");
    const quota = failed.some(
      (f) => isQuotaErrorMessage(f.error) || isQuotaErrorMessage(f.meta.rawResponse)
    );
    if (quota) {
      throw new ApiError(
        429,
        `AI provider rate limit / quota exhausted (target ${rpmTarget()} requests/minute). ` +
          `The server waited and retried but the quota hasn't cleared — please wait a minute ` +
          `and try again. Affected: ${names}`
      );
    }
    throw new ApiError(502, `AI extraction failed for ${names}: ${failed[0].error}`);
  }

  const extractions = outcomes.map((o, i) => {
    const r = o.result!;
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

/** Pre-stream (auth/validation) failures still return plain JSON — the client
 *  reads them before switching to stream mode. */
export function apiErrorJson(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("API error:", err);
  const message = err instanceof Error ? err.message : "Internal error";
  return NextResponse.json({ error: message }, { status: 500 });
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
