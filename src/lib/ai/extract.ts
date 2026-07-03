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

export interface ExtractionResult {
  items: ExtractedItem[];
  meta: ExtractionMeta;
}

/** Thrown when extraction fails; carries the call metadata so it can be logged. */
export class ExtractionError extends Error {
  constructor(message: string, public meta: ExtractionMeta) {
    super(message);
  }
}

function receiptsMetaJson(receipts: ReceiptInput[]): string {
  return JSON.stringify(
    receipts.map((r) => ({ id: r.id, name: r.originalName, mimeType: r.mimeType }))
  );
}

/**
 * Send a batch of receipts to GLM and get back validated line items plus the
 * request/response metadata. With AI_MOCK=1 this returns deterministic data
 * without any network call (logged with model "mock").
 */
export async function extractLineItems(receipts: ReceiptInput[]): Promise<ExtractionResult> {
  if (receipts.length === 0) throw new Error("No receipts to extract");

  const prompt = buildExtractionPrompt(receipts.map((r) => r.id));
  const receiptsJson = receiptsMetaJson(receipts);
  const started = Date.now();

  if (isAiMock()) {
    const items = mockExtract(receipts);
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

  const model = process.env.GLM_MODEL || "glm-5.2";
  const failMeta = (rawResponse: string | null): ExtractionMeta => ({
    model,
    prompt,
    receiptsJson,
    rawResponse,
    durationMs: Date.now() - started,
  });

  const apiKey = process.env.GLM_API_KEY;
  if (!apiKey) {
    throw new ExtractionError(
      "GLM_API_KEY is not configured (set AI_MOCK=1 for offline use)",
      failMeta(null)
    );
  }
  const baseUrl = (process.env.GLM_BASE_URL || "https://api.z.ai/api/paas/v4").replace(/\/$/, "");

  const content: unknown[] = [{ type: "text", text: prompt }];
  for (const receipt of receipts) {
    const data = await readStoredFile(receipt.filePath);
    const dataUri = `data:${receipt.mimeType};base64,${data.toString("base64")}`;
    content.push({ type: "text", text: `RECEIPT ID: ${receipt.id}` });
    if (receipt.mimeType === "application/pdf") {
      // OpenRouter-style file attachment; Z.ai accepts the same shape.
      content.push({
        type: "file",
        file: { filename: receipt.originalName, file_data: dataUri },
      });
    } else {
      content.push({ type: "image_url", image_url: { url: dataUri } });
    }
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        temperature: 0.1,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network error";
    throw new ExtractionError(`GLM API unreachable: ${msg}`, failMeta(null));
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ExtractionError(`GLM API error ${res.status}: ${body.slice(0, 500)}`, failMeta(body.slice(0, 10_000)));
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = json.choices?.[0]?.message?.content;
  if (!text) {
    throw new ExtractionError("GLM API returned an empty response", failMeta(JSON.stringify(json).slice(0, 10_000)));
  }

  let items: ExtractedItem[];
  try {
    items = parseExtractionResponse(
      text,
      receipts.map((r) => r.id)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "parse error";
    throw new ExtractionError(msg, failMeta(text));
  }

  return {
    items,
    meta: { model, prompt, receiptsJson, rawResponse: text, durationMs: Date.now() - started },
  };
}
