import { describe, expect, it } from "vitest";
import {
  annotationClaimRow,
  isAnnotated,
  outcomeClaimRow,
  type AnnotatedReceiptFields,
} from "@/lib/claims-rows";
import type { ReceiptExtraction } from "@/lib/ai/extract";

function annotated(over: Partial<AnnotatedReceiptFields> = {}): AnnotatedReceiptFields {
  return {
    id: "r1",
    merchant: "Costco Wholesale",
    purchaseDate: "2026-06-21",
    extractedTotalCents: 10210,
    extractedRefundCents: 0,
    extractedSummary: "Paper towels, snack variety pack, 6ft folding table",
    annotatedAt: new Date("2026-07-01T00:00:00Z"),
    annotationSource: "ai",
    ...over,
  };
}

const receiptInput = {
  id: "r1",
  filePath: "uploads/u/r1.webp",
  mimeType: "image/webp",
  originalName: "costco.jpg",
};

describe("isAnnotated", () => {
  it("is exactly 'annotatedAt is set'", () => {
    expect(isAnnotated(annotated())).toBe(true);
    expect(isAnnotated({ annotatedAt: null })).toBe(false);
  });
});

describe("annotationClaimRow (stored annotation → row, no AI call)", () => {
  it("composes the description and net amount, freezing AI originals", () => {
    const row = annotationClaimRow(annotated(), 2);
    expect(row.receiptUpdate).toBeUndefined(); // receipt already stamped
    expect(row.item).toEqual({
      receiptId: "r1",
      description:
        "Costco Wholesale 06/21 — Paper towels, snack variety pack, 6ft folding table",
      amountCents: 10210,
      ministry: "", // never AI-assigned (human-in-the-loop gate)
      sortOrder: 2,
      originalDescription:
        "Costco Wholesale 06/21 — Paper towels, snack variety pack, 6ft folding table",
      originalAmountCents: 10210,
    });
  });

  it("subtracts the printed refund from the printed total", () => {
    const row = annotationClaimRow(
      annotated({ extractedTotalCents: 3631, extractedRefundCents: 536 }),
      0
    );
    expect(row.item.amountCents).toBe(3095);
  });

  it("omits the date part when the annotation has none", () => {
    const row = annotationClaimRow(annotated({ purchaseDate: "" }), 0);
    expect(row.item.description).toBe(
      "Costco Wholesale — Paper towels, snack variety pack, 6ft folding table"
    );
  });

  it("a human-typed (manual) annotation leaves original* null — human-created values", () => {
    const row = annotationClaimRow(annotated({ annotationSource: "manual" }), 1);
    expect(row.item.description).toContain("Costco Wholesale");
    expect(row.item.amountCents).toBe(10210);
    expect(row.item.originalDescription).toBeNull();
    expect(row.item.originalAmountCents).toBeNull();
  });
});

describe("outcomeClaimRow (fresh extraction → row)", () => {
  it("a failed read becomes a blank manual-entry placeholder with no receipt stamp", () => {
    const outcome: ReceiptExtraction = {
      receipt: receiptInput,
      result: null,
      error: "Mock: receipt could not be read",
      meta: { model: "mock", prompt: "p", receiptsJson: "[]", rawResponse: null, durationMs: 1 },
    };
    const row = outcomeClaimRow(outcome, 3);
    expect(row.receiptUpdate).toBeUndefined();
    expect(row.item).toEqual({
      receiptId: "r1",
      description: "",
      amountCents: 0,
      ministry: "",
      sortOrder: 3,
      originalDescription: null,
      originalAmountCents: null,
    });
  });

  it("a successful read stamps the receipt's annotation so the NEXT claim skips the call", () => {
    const outcome: ReceiptExtraction = {
      receipt: receiptInput,
      result: {
        receiptId: "r1",
        merchant: "Amazon",
        purchaseDate: "2026-06-04",
        totalAmount: 36.31,
        refundAmount: 5.36,
        summary: "Paper plates (refunded), rulers, duct tape, clothespins",
      },
      error: null,
      meta: { model: "mock", prompt: "p", receiptsJson: "[]", rawResponse: "{}", durationMs: 1 },
    };
    const row = outcomeClaimRow(outcome, 0);
    expect(row.receiptUpdate).toMatchObject({
      id: "r1",
      merchant: "Amazon",
      purchaseDate: "2026-06-04",
      extractedTotalCents: 3631,
      extractedRefundCents: 536,
      extractedSummary: "Paper plates (refunded), rulers, duct tape, clothespins",
      annotationSource: "ai",
    });
    expect(row.receiptUpdate!.annotatedAt).toBeInstanceOf(Date);
    expect(row.item.amountCents).toBe(3095);
    expect(row.item.originalAmountCents).toBe(3095);
    expect(row.item.originalDescription).toBe(row.item.description);
  });

  it("round-trips with annotationClaimRow: consuming the stamp reproduces the same row", () => {
    const outcome: ReceiptExtraction = {
      receipt: receiptInput,
      result: {
        receiptId: "r1",
        merchant: "Costco Wholesale",
        purchaseDate: "2026-06-21",
        totalAmount: 102.1,
        refundAmount: 0,
        summary: "Paper towels, snack variety pack, 6ft folding table",
      },
      error: null,
      meta: { model: "mock", prompt: "p", receiptsJson: "[]", rawResponse: "{}", durationMs: 1 },
    };
    const fresh = outcomeClaimRow(outcome, 0);
    const consumed = annotationClaimRow(
      {
        id: "r1",
        merchant: fresh.receiptUpdate!.merchant,
        purchaseDate: fresh.receiptUpdate!.purchaseDate,
        extractedTotalCents: fresh.receiptUpdate!.extractedTotalCents,
        extractedRefundCents: fresh.receiptUpdate!.extractedRefundCents,
        extractedSummary: fresh.receiptUpdate!.extractedSummary,
        annotatedAt: fresh.receiptUpdate!.annotatedAt,
        annotationSource: fresh.receiptUpdate!.annotationSource,
      },
      0
    );
    expect(consumed.item).toEqual(fresh.item);
  });
});
