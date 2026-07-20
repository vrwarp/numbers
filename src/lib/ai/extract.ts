import { readStoredFile } from "@/lib/storage";
import { isAiMock, quotaCooldownMs, quotaMaxRetries } from "@/lib/config";
import { buildExtractionPrompt } from "./prompt";
import { parseExtractionResponse } from "./parse";
import { mockExtract } from "./mock";
import {
  callProvider,
  currentProvider,
  providerApiKey,
  providerModel,
  ProviderCallError,
  type AiProvider,
  type ProviderDocument,
} from "./providers";
import { acquireRateSlot, withQuotaRetry } from "./throttle";
import type { ExtractedReceipt } from "./schema";

export interface ReceiptInput {
  id: string;
  filePath: string;
  mimeType: string;
  originalName: string;
}

/** Everything about one extraction call worth persisting for prompt tuning. */
export interface ExtractionMeta {
  model: string;
  prompt: string;
  /** Receipt metadata that went with the prompt (never the image bytes). */
  receiptsJson: string;
  rawResponse: string | null;
  durationMs: number;
}

/** Settled outcome of the extraction call for one receipt. */
export interface ReceiptExtraction {
  receipt: ReceiptInput;
  /** null = the call failed (see error). */
  result: ExtractedReceipt | null;
  error: string | null;
  meta: ExtractionMeta;
}

/** Thrown when extraction fails; carries the call metadata so it can be logged. */
export class ExtractionError extends Error {
  constructor(message: string, public meta: ExtractionMeta) {
    super(message);
  }
}

/** Progress events emitted while extracting a batch (for live UI streaming). */
export type ExtractionEvent =
  | {
      type: "quota-wait";
      receiptId: string;
      receiptName: string;
      attempt: number;
      maxRetries: number;
      cooldownMs: number;
      message: string;
    }
  | {
      type: "receipt-done";
      receiptId: string;
      receiptName: string;
      ok: boolean;
      completed: number;
      total: number;
    };

export type ExtractionEventHandler = (event: ExtractionEvent) => void;

// Per-receipt calls in flight at once; keeps a big claim fast without
// tripping provider rate limits.
export const EXTRACTION_CONCURRENCY = 3;

/** Caller-tunable behavior of one extraction call. */
export interface ExtractOptions {
  /** Override AI_QUOTA_MAX_RETRIES. The background annotation worker passes 0:
   *  its queue reschedule IS the quota retry, so sleeping out cooldowns inside
   *  the call would only hold its lease for nothing. */
  quotaMaxRetries?: number;
}

/**
 * Make one provider call, but first wait for a slot in the process-wide RPM
 * budget, and on a quota/rate-limit rejection wait out the cooldown and retry.
 * Every wait is surfaced through onEvent (and logged) so the user learns why a
 * claim is taking longer.
 */
function callProviderThrottled(
  provider: AiProvider,
  apiKey: string,
  model: string,
  prompt: string,
  doc: ProviderDocument,
  receipt: ReceiptInput,
  onEvent?: ExtractionEventHandler,
  opts?: ExtractOptions
): Promise<string> {
  return withQuotaRetry(
    async () => {
      await acquireRateSlot();
      return callProvider(provider, apiKey, model, prompt, doc);
    },
    {
      maxRetries: opts?.quotaMaxRetries ?? quotaMaxRetries(),
      cooldownMs: quotaCooldownMs(),
      onWait: ({ attempt, maxRetries, cooldownMs, error }) => {
        const seconds = Math.round(cooldownMs / 1000);
        const message = `Rate limit reached — waiting ${seconds}s before retrying (${attempt}/${maxRetries})…`;
        console.warn(
          `[extract] ${receipt.originalName}: ${message} Provider said: ${error}`
        );
        onEvent?.({
          type: "quota-wait",
          receiptId: receipt.id,
          receiptName: receipt.originalName,
          attempt,
          maxRetries,
          cooldownMs,
          message,
        });
      },
    }
  );
}

function currentModel(): string {
  if (isAiMock()) return "mock";
  try {
    return providerModel(currentProvider());
  } catch {
    return "unknown";
  }
}

function receiptMetaJson(receipt: ReceiptInput): string {
  return JSON.stringify([
    { id: receipt.id, name: receipt.originalName, mimeType: receipt.mimeType },
  ]);
}

/**
 * Send ONE receipt to the configured AI provider (AI_PROVIDER: OpenRouter or
 * Google AI Studio) and get back a validated receipt-level result stamped
 * with the receipt id, plus the request/response metadata. Small vision
 * models mix up attribution when several documents share a context, so
 * batching is deliberately not supported. With AI_MOCK=1 this returns
 * deterministic data without any network call (logged with model "mock").
 */
export async function extractReceipt(
  receipt: ReceiptInput,
  onEvent?: ExtractionEventHandler,
  opts?: ExtractOptions
): Promise<{ result: ExtractedReceipt; meta: ExtractionMeta }> {
  const prompt = buildExtractionPrompt();
  const receiptsJson = receiptMetaJson(receipt);
  const started = Date.now();

  if (isAiMock()) {
    const result = mockExtract(receipt);
    return {
      result,
      meta: {
        model: "mock",
        prompt,
        receiptsJson,
        rawResponse: JSON.stringify(result),
        durationMs: Date.now() - started,
      },
    };
  }

  let model = "unknown";
  const failMeta = (rawResponse: string | null): ExtractionMeta => ({
    model,
    prompt,
    receiptsJson,
    rawResponse,
    durationMs: Date.now() - started,
  });

  let provider: AiProvider;
  let apiKey: string;
  try {
    provider = currentProvider();
    model = providerModel(provider);
    apiKey = providerApiKey(provider);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI provider misconfigured";
    throw new ExtractionError(msg, failMeta(null));
  }

  let data: Buffer;
  try {
    data = await readStoredFile(receipt.filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "read error";
    throw new ExtractionError(`Could not read receipt file: ${msg}`, failMeta(null));
  }

  let text: string;
  try {
    text = await callProviderThrottled(
      provider,
      apiKey,
      model,
      prompt,
      {
        mimeType: receipt.mimeType,
        originalName: receipt.originalName,
        base64: data.toString("base64"),
      },
      receipt,
      onEvent,
      opts
    );
  } catch (err) {
    if (err instanceof ProviderCallError) {
      throw new ExtractionError(err.message, failMeta(err.rawResponse));
    }
    const msg = err instanceof Error ? err.message : "extraction failed";
    throw new ExtractionError(msg, failMeta(null));
  }

  let result: ExtractedReceipt;
  try {
    result = parseExtractionResponse(text, receipt.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "parse error";
    throw new ExtractionError(msg, failMeta(text));
  }

  return {
    result,
    meta: { model, prompt, receiptsJson, rawResponse: text, durationMs: Date.now() - started },
  };
}

/**
 * Extract every receipt with one model call each, EXTRACTION_CONCURRENCY at
 * a time. Never rejects: each outcome reports success (result) or failure
 * (error) and always carries meta, so the caller can telemetry-log every
 * call — including the ones that failed.
 */
export async function extractReceipts(
  receipts: ReceiptInput[],
  onEvent?: ExtractionEventHandler
): Promise<ReceiptExtraction[]> {
  if (receipts.length === 0) throw new Error("No receipts to extract");
  const total = receipts.length;
  let completed = 0;
  return mapWithConcurrency(receipts, EXTRACTION_CONCURRENCY, async (receipt) => {
    let outcome: ReceiptExtraction;
    try {
      const { result, meta } = await extractReceipt(receipt, onEvent);
      outcome = { receipt, result, error: null, meta };
    } catch (err) {
      const message = err instanceof Error ? err.message : "extraction failed";
      const meta: ExtractionMeta =
        err instanceof ExtractionError
          ? err.meta
          : {
              model: currentModel(),
              prompt: buildExtractionPrompt(),
              receiptsJson: receiptMetaJson(receipt),
              rawResponse: null,
              durationMs: 0,
            };
      outcome = { receipt, result: null, error: message, meta };
    }
    completed += 1;
    onEvent?.({
      type: "receipt-done",
      receiptId: receipt.id,
      receiptName: receipt.originalName,
      ok: outcome.result !== null,
      completed,
      total,
    });
    return outcome;
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
