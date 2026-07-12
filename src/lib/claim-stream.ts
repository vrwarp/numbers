/**
 * NDJSON progress lines streamed by the claim-building POSTs
 * (POST /api/reimbursements and POST /api/reimbursements/[id]/receipts).
 * Dependency-free so client components can share it with the server routes;
 * the two event shapes mirror ExtractionEvent in src/lib/ai/extract.ts.
 */
export type ClaimStreamMessage =
  | { type: "status"; phase: "extracting"; total: number }
  | {
      type: "receipt-done";
      receiptId: string;
      receiptName: string;
      ok: boolean;
      completed: number;
      total: number;
    }
  | {
      type: "quota-wait";
      receiptId: string;
      receiptName: string;
      attempt: number;
      maxRetries: number;
      cooldownMs: number;
      message: string;
    }
  | { type: "done"; reimbursementId: string }
  | {
      type: "error";
      status: number;
      /** English text — display fallback and log line. */
      message: string;
      /** Machine-readable identity for client-side translation (Errors.*). */
      code?: string;
      params?: Record<string, string | number>;
    };
