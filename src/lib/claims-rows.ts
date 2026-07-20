import { composeDescription } from "@/lib/ai/compose";
import { parseDollarsToCents } from "@/lib/money";
import type { ReceiptExtraction } from "@/lib/ai/extract";

/**
 * Pure mapping from a receipt's annotation (background-stamped or human-typed)
 * or a fresh extraction outcome to claim-row data — shared by the two
 * claim-building routes via src/lib/claims.ts and dependency-free so the unit
 * suite can cover it without a database.
 */

/** The Receipt columns the row builders read (structural, so tests and the
 *  routes' Prisma rows both fit). */
export interface AnnotatedReceiptFields {
  id: string;
  merchant: string;
  purchaseDate: string;
  extractedTotalCents: number | null;
  extractedRefundCents: number | null;
  extractedSummary: string;
  annotatedAt: Date | null;
  annotationSource: string;
}

export interface ClaimExtraction {
  /** Extraction fields to stamp onto the Receipt row. Absent when the row was
   *  built from a stored annotation (the receipt is already stamped) or when
   *  extraction failed and the row is a manual-entry placeholder. */
  receiptUpdate?: {
    id: string;
    merchant: string;
    purchaseDate: string;
    extractedTotalCents: number;
    extractedRefundCents: number;
    extractedSummary: string;
    annotatedAt: Date;
    annotationSource: string;
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

/** A receipt whose annotation can be consumed without an AI call. */
export function isAnnotated(r: Pick<AnnotatedReceiptFields, "annotatedAt">): boolean {
  return r.annotatedAt !== null;
}

/**
 * Build a claim row from the receipt's STORED annotation — no AI call. An
 * AI-sourced annotation freezes its composed values into original* exactly as
 * a claim-time extraction would have; a human-typed one ("manual", from the
 * manual-entry dialog) leaves original* null, the human-created convention —
 * there was no AI output to correct.
 */
export function annotationClaimRow(r: AnnotatedReceiptFields, sortOrder: number): ClaimExtraction {
  const description = composeDescription({
    merchant: r.merchant,
    purchaseDate: r.purchaseDate || null,
    summary: r.extractedSummary,
  });
  const amountCents = (r.extractedTotalCents ?? 0) - (r.extractedRefundCents ?? 0);
  const fromAi = r.annotationSource === "ai";
  return {
    item: {
      receiptId: r.id,
      description,
      amountCents,
      // The model never assigns ministries; the user picks one per row during
      // review (a row cannot be verified without one).
      ministry: "",
      sortOrder,
      originalDescription: fromAi ? description : null,
      originalAmountCents: fromAi ? amountCents : null,
    },
  };
}

/**
 * Map a fresh extraction outcome to row data. A receipt the model could not
 * read becomes a blank MANUAL-ENTRY row (no receiptUpdate — the receipt keeps
 * whatever metadata it had); a read one stamps the receipt's annotation (so
 * later claims skip the AI call) and freezes the AI values into original*.
 */
export function outcomeClaimRow(o: ReceiptExtraction, sortOrder: number): ClaimExtraction {
  if (o.result === null) {
    return {
      item: {
        receiptId: o.receipt.id,
        description: "",
        amountCents: 0,
        ministry: "",
        sortOrder,
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
      extractedSummary: r.summary,
      annotatedAt: new Date(),
      annotationSource: "ai",
    },
    item: {
      receiptId: r.receiptId,
      description,
      // The suggested amount is a derivation of two printed numbers; the
      // review UI shows it ("charged X − refunded Y") for the human to
      // verify against what they actually paid.
      amountCents: totalCents - refundCents,
      ministry: "",
      sortOrder,
      // Frozen AI snapshot for later original-vs-final comparison.
      originalDescription: description,
      originalAmountCents: totalCents - refundCents,
    },
  };
}
