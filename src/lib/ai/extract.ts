import { readStoredFile } from "@/lib/storage";
import { isAiMock } from "@/lib/config";
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
} from "./providers";
import type { ExtractedItem } from "./schema";

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
  items: ExtractedItem[] | null;
  error: string | null;
  meta: ExtractionMeta;
}

/** Thrown when extraction fails; carries the call metadata so it can be logged. */
export class ExtractionError extends Error {
  constructor(message: string, public meta: ExtractionMeta) {
    super(message);
  }
}

// Per-receipt calls in flight at once; keeps a big claim fast without
// tripping provider rate limits.
export const EXTRACTION_CONCURRENCY = 3;

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
 * Google AI Studio) and get back validated line items stamped with the
 * receipt id, plus the request/response metadata. Small vision models mix up
 * attribution when several documents share a context, so batching is
 * deliberately not supported. With AI_MOCK=1 this returns deterministic data
 * without any network call (logged with model "mock").
 */
export async function extractReceipt(
  receipt: ReceiptInput
): Promise<{ items: ExtractedItem[]; meta: ExtractionMeta }> {
  const prompt = buildExtractionPrompt();
  const receiptsJson = receiptMetaJson(receipt);
  const started = Date.now();

  if (isAiMock()) {
    const items = mockExtract([receipt]);
    return {
      items,
      meta: {
        model: "mock",
        prompt,
        receiptsJson,
        rawResponse: JSON.stringify(items),
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
    text = await callProvider(provider, apiKey, model, prompt, {
      mimeType: receipt.mimeType,
      originalName: receipt.originalName,
      base64: data.toString("base64"),
    });
  } catch (err) {
    if (err instanceof ProviderCallError) {
      throw new ExtractionError(err.message, failMeta(err.rawResponse));
    }
    const msg = err instanceof Error ? err.message : "extraction failed";
    throw new ExtractionError(msg, failMeta(null));
  }

  let items: ExtractedItem[];
  try {
    items = parseExtractionResponse(text, receipt.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "parse error";
    throw new ExtractionError(msg, failMeta(text));
  }

  return {
    items,
    meta: { model, prompt, receiptsJson, rawResponse: text, durationMs: Date.now() - started },
  };
}

/**
 * Extract every receipt with one model call each, EXTRACTION_CONCURRENCY at
 * a time. Never rejects: each outcome reports success (items) or failure
 * (error) and always carries meta, so the caller can telemetry-log every
 * call — including the ones that failed.
 */
export async function extractReceipts(receipts: ReceiptInput[]): Promise<ReceiptExtraction[]> {
  if (receipts.length === 0) throw new Error("No receipts to extract");
  return mapWithConcurrency(receipts, EXTRACTION_CONCURRENCY, async (receipt) => {
    try {
      const { items, meta } = await extractReceipt(receipt);
      return { receipt, items, error: null, meta };
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
      return { receipt, items: null, error: message, meta };
    }
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
