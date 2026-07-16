import sharp from "sharp";
import { configValue } from "@/lib/config-file";
import { isEmbeddingMock } from "./settings-shared";
import { mockEmbed, mockTokens, MOCK_DIM } from "./mock";
import type { ModelConfig } from "./types";

/**
 * The ONE module that talks to the embedding endpoint (verified contract,
 * docs/SEARCH_DESIGN.md §3.1 — llama.cpp serving qwen3-vl-embedding-2b):
 *  - text  → POST <base>/v1/embeddings  {model, input}
 *  - image → POST <base>/embeddings     {content:[{prompt_string, multimodal_data}]}
 *    with raw base64 (no data-URI), one <__media__> token per image, and the
 *    input normalized to a ≤EMBEDDING_MAX_PX JPEG (endpoint rejects WebP/PDF;
 *    oversized images cost ~6× the latency for a near-identical vector).
 * Always returns unit vectors of exactly cfg.dim, or throws EmbedError.
 */

export class EmbedError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

function timeoutMs(): number {
  return Number(configValue("EMBEDDING_TIMEOUT_MS") ?? 120000);
}

export function maxPx(): number {
  return Number(configValue("EMBEDDING_MAX_PX") ?? 640);
}

async function callEndpoint(cfg: ModelConfig, path: string, body: object): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetch(cfg.endpoint.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new EmbedError(
        `Embedding endpoint ${res.status}: ${text.slice(0, 300)}`,
        res.status
      );
    }
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof EmbedError) throw err;
    throw new EmbedError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Both response shapes: native → [{index, embedding}]; /v1 → {data:[{embedding}]}. */
function firstVector(json: unknown): number[] | null {
  const rows = Array.isArray(json)
    ? json
    : (json as { data?: unknown[] })?.data;
  if (!Array.isArray(rows) || !rows.length) return null;
  const e = (rows[0] as { embedding?: unknown }).embedding;
  if (Array.isArray(e) && Array.isArray(e[0])) return e[0] as number[];
  return Array.isArray(e) ? (e as number[]) : null;
}

function finalize(raw: number[] | null, cfg: ModelConfig): Float32Array {
  if (!raw) throw new EmbedError("Embedding endpoint returned no vector");
  if (cfg.dim && raw.length !== cfg.dim) {
    throw new EmbedError(
      `Embedding dimension mismatch: got ${raw.length}, expected ${cfg.dim}`
    );
  }
  const v = Float32Array.from(raw);
  let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new EmbedError("Degenerate embedding vector");
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

export async function embedText(text: string, cfg: ModelConfig): Promise<Float32Array> {
  if (isEmbeddingMock()) return mockEmbed(text, cfg);
  const json = await callEndpoint(cfg, "/v1/embeddings", { model: cfg.model, input: text });
  return finalize(firstVector(json), cfg);
}

/**
 * Normalize any stored receipt image (WebP/PNG/JPEG, any size) to the JPEG
 * the endpoint accepts, capped at maxPx() on the long side. Exported for the
 * probe route and tests.
 */
export async function normalizeImageForEmbedding(bytes: Buffer): Promise<Buffer> {
  const px = maxPx();
  return sharp(bytes)
    .rotate() // honor EXIF, same as the storage pipeline
    .resize({ width: px, height: px, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

export async function embedImage(
  bytes: Buffer,
  text: string | undefined,
  cfg: ModelConfig
): Promise<Float32Array> {
  if (isEmbeddingMock()) {
    // Mock has no vision: fold the paired text plus a per-image stand-in token
    // (image byte-hash) so distinct images embed distinctly but pair with text.
    const standIn = `img_${bytes.length}_${bytes.subarray(0, 64).toString("hex")}`;
    return mockEmbed(`${text ?? ""} ${standIn}`, cfg);
  }
  const jpeg = await normalizeImageForEmbedding(bytes);
  const prompt = text && text.trim() ? `${text.trim()} <__media__>` : "<__media__>";
  const json = await callEndpoint(cfg, "/embeddings", {
    content: [{ prompt_string: prompt, multimodal_data: [jpeg.toString("base64")] }],
  });
  return finalize(firstVector(json), cfg);
}

/**
 * Save-time probe (docs/SEARCH_DESIGN.md §3.2): embed a fixed string with a
 * 10 s timeout, DETECT the dimension (admins never type "2048"), and report
 * latency. Bypasses the dim check by probing with dim 0.
 */
export async function probeEndpoint(
  cfg: Omit<ModelConfig, "dim">
): Promise<{ dim: number; ms: number }> {
  if (isEmbeddingMock()) return { dim: MOCK_DIM, ms: 1 };
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(cfg.endpoint.replace(/\/+$/, "") + "/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: cfg.model, input: "connection probe" }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new EmbedError(`Probe failed (${res.status}): ${text.slice(0, 200)}`, res.status);
    const vec = firstVector(JSON.parse(text));
    if (!vec?.length) throw new EmbedError("Probe returned no vector");
    return { dim: vec.length, ms: Date.now() - t0 };
  } catch (err) {
    if (err instanceof EmbedError) throw err;
    throw new EmbedError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

export { mockTokens };
