/**
 * HTTP backends for receipt extraction. Each caller sends the prompt plus one
 * receipt document and returns the model's raw text response. Failures throw
 * ProviderCallError carrying whatever response body came back, so the caller
 * can persist it to the ExtractionLog.
 */

export type AiProvider = "openrouter" | "google";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const GOOGLE_AI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
// Vision default: leads document/receipt extraction benchmarks at ~$0.001 per
// receipt and ingests PDFs natively. Override with OPENROUTER_MODEL.
export const DEFAULT_OPENROUTER_MODEL = "google/gemini-3.1-flash-lite";
// Same model, addressed directly on Google AI Studio. Override with GEMINI_MODEL.
export const DEFAULT_GOOGLE_MODEL = "gemini-3.1-flash-lite";

/** One receipt document, ready to inline into a model request. */
export interface ProviderDocument {
  mimeType: string;
  originalName: string;
  base64: string;
}

/** Provider misconfiguration or a failed HTTP call; rawResponse (when present)
 *  is the response body, capped for logging. status is the HTTP status code
 *  when the call reached the provider (null for network/config failures) so
 *  callers can single out quota errors (429). */
export class ProviderCallError extends Error {
  constructor(
    message: string,
    public rawResponse: string | null = null,
    public status: number | null = null
  ) {
    super(message);
  }
}

/** Backend selected by AI_PROVIDER (default openrouter); throws on unknown values. */
export function currentProvider(): AiProvider {
  const raw = (process.env.AI_PROVIDER || "openrouter").toLowerCase();
  if (raw !== "openrouter" && raw !== "google") {
    throw new ProviderCallError(
      `Unknown AI_PROVIDER "${raw}" (expected "openrouter" or "google")`
    );
  }
  return raw;
}

export function providerModel(provider: AiProvider): string {
  return provider === "google"
    ? process.env.GEMINI_MODEL || DEFAULT_GOOGLE_MODEL
    : process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
}

export function providerApiKey(provider: AiProvider): string {
  const envVar = provider === "google" ? "GEMINI_API_KEY" : "OPENROUTER_API_KEY";
  const key = process.env[envVar];
  if (!key) {
    throw new ProviderCallError(
      `${envVar} is not configured (set AI_MOCK=1 for offline use)`
    );
  }
  return key;
}

export async function callProvider(
  provider: AiProvider,
  apiKey: string,
  model: string,
  prompt: string,
  doc: ProviderDocument
): Promise<string> {
  return provider === "google"
    ? callGoogle(apiKey, model, prompt, doc)
    : callOpenRouter(apiKey, model, prompt, doc);
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  prompt: string,
  doc: ProviderDocument
): Promise<string> {
  const dataUri = `data:${doc.mimeType};base64,${doc.base64}`;
  const content: unknown[] = [{ type: "text", text: prompt }];
  if (doc.mimeType === "application/pdf") {
    content.push({
      type: "file",
      file: { filename: doc.originalName, file_data: dataUri },
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
    throw new ProviderCallError(`OpenRouter API unreachable: ${msg}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderCallError(
      `OpenRouter API error ${res.status}: ${body.slice(0, 500)}`,
      body.slice(0, 10_000),
      res.status
    );
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = json.choices?.[0]?.message?.content;
  if (!text) {
    throw new ProviderCallError(
      "OpenRouter API returned an empty response",
      JSON.stringify(json).slice(0, 10_000)
    );
  }
  return text;
}

// Google AI Studio (Gemini API) generateContent call. Images and PDFs both go
// through inline_data — no separate file shape like OpenRouter's.
async function callGoogle(
  apiKey: string,
  model: string,
  prompt: string,
  doc: ProviderDocument
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(
      `${GOOGLE_AI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                { inline_data: { mime_type: doc.mimeType, data: doc.base64 } },
              ],
            },
          ],
          generationConfig: { temperature: 0.1 },
        }),
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network error";
    throw new ProviderCallError(`Google AI Studio API unreachable: ${msg}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderCallError(
      `Google AI Studio API error ${res.status}: ${body.slice(0, 500)}`,
      body.slice(0, 10_000),
      res.status
    );
  }

  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");
  if (!text) {
    throw new ProviderCallError(
      "Google AI Studio API returned an empty response",
      JSON.stringify(json).slice(0, 10_000)
    );
  }
  return text;
}
