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

/**
 * Send a batch of receipts to GLM and get back validated line items.
 * With AI_MOCK=1 this returns deterministic data without any network call.
 */
export async function extractLineItems(receipts: ReceiptInput[]): Promise<ExtractedItem[]> {
  if (receipts.length === 0) throw new Error("No receipts to extract");
  if (isAiMock()) return mockExtract(receipts);

  const apiKey = process.env.GLM_API_KEY;
  if (!apiKey) {
    throw new Error("GLM_API_KEY is not configured (set AI_MOCK=1 for offline use)");
  }
  const baseUrl = (process.env.GLM_BASE_URL || "https://api.z.ai/api/paas/v4").replace(/\/$/, "");
  const model = process.env.GLM_MODEL || "glm-5.2";

  const content: unknown[] = [{ type: "text", text: buildExtractionPrompt(receipts.map((r) => r.id)) }];
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

  const res = await fetch(`${baseUrl}/chat/completions`, {
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

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GLM API error ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("GLM API returned an empty response");

  return parseExtractionResponse(
    text,
    receipts.map((r) => r.id)
  );
}
