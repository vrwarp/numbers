import { readStoredFile } from "@/lib/storage";
import { isAiMock } from "@/lib/config";
import { buildExtractionPrompt } from "./prompt";
import { parseExtractionResponse } from "./parse";
import { mockExtract } from "./mock";
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

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// Vision default: leads document/receipt extraction benchmarks at ~$0.001 per
// receipt and ingests PDFs natively. Override with OPENROUTER_MODEL.
export const DEFAULT_MODEL = "google/gemini-3.1-flash-lite";
// Per-receipt calls in flight at once; keeps a big claim fast without
// tripping provider rate limits.
export const EXTRACTION_CONCURRENCY = 3;

function currentModel(): string {
  return isAiMock() ? "mock" : process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
}

function receiptMetaJson(receipt: ReceiptInput): string {
  return JSON.stringify([
    { id: receipt.id, name: receipt.originalName, mimeType: receipt.mimeType },
  ]);
}

/**
 * Send ONE receipt to OpenRouter and get back validated line items stamped
 * with the receipt id, plus the request/response metadata. Small vision
 * models mix up attribution when several documents share a context, so
 * batching is deliberately not supported. With AI_MOCK=1 this returns
 * deterministic data without any network call (logged with model "mock").
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

  const model = currentModel();
  const failMeta = (rawResponse: string | null): ExtractionMeta => ({
    model,
    prompt,
    receiptsJson,
    rawResponse,
    durationMs: Date.now() - started,
  });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new ExtractionError(
      "OPENROUTER_API_KEY is not configured (set AI_MOCK=1 for offline use)",
      failMeta(null)
    );
  }

  let data: Buffer;
  try {
    data = await readStoredFile(receipt.filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "read error";
    throw new ExtractionError(`Could not read receipt file: ${msg}`, failMeta(null));
  }
  const dataUri = `data:${receipt.mimeType};base64,${data.toString("base64")}`;
  const content: unknown[] = [{ type: "text", text: prompt }];
  if (receipt.mimeType === "application/pdf") {
    content.push({
      type: "file",
      file: { filename: receipt.originalName, file_data: dataUri },
    });
  } else {
    content.push({ type: "image_url", image_url: { url: dataUri } });
  }

  let res: Response;
  try {
    res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Title": "Numbers",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        temperature: 0.1,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network error";
    throw new ExtractionError(`OpenRouter API unreachable: ${msg}`, failMeta(null));
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ExtractionError(`OpenRouter API error ${res.status}: ${body.slice(0, 500)}`, failMeta(body.slice(0, 10_000)));
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = json.choices?.[0]?.message?.content;
  if (!text) {
    throw new ExtractionError("OpenRouter API returned an empty response", failMeta(JSON.stringify(json).slice(0, 10_000)));
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
