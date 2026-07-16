import { prisma } from "@/lib/prisma";
import { configValue } from "@/lib/config-file";
import { isEmbeddingMock, embeddingAllowedInThisEnv } from "./settings-shared";
import { MOCK_DIM } from "./mock";
import type { ModelConfig } from "./types";

/**
 * The single accessor for the embedding backend config
 * (docs/SEARCH_DESIGN.md §3.2): DB row → seeded on first read from
 * EMBEDDING_* config values (config.json → env). After the seed, the DB row
 * is authoritative; the admin card is the way to change it.
 */

export type EmbeddingSettingsRow = {
  id: string;
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  model: string;
  dim: number;
  queryPrefix: string;
  minScoreMilli: number;
};

const DEFAULT_QUERY_PREFIX =
  "Instruct: Retrieve the receipt matching the query. Query: ";

async function seedFromEnv(): Promise<EmbeddingSettingsRow | null> {
  if (isEmbeddingMock()) {
    return prisma.embeddingSettings.create({
      data: {
        enabled: true,
        endpoint: "mock://",
        apiKey: "",
        model: configValue("EMBEDDING_MODEL") || "mock-model-a",
        dim: MOCK_DIM,
        queryPrefix: "",
        minScoreMilli: 100, // mock cosines are lower than the real model's
      },
    });
  }
  const endpoint = configValue("EMBEDDING_ENDPOINT");
  if (!endpoint || !embeddingAllowedInThisEnv()) return null;
  return prisma.embeddingSettings.create({
    data: {
      enabled: true,
      endpoint,
      apiKey: configValue("EMBEDDING_API_KEY") || "",
      model: configValue("EMBEDDING_MODEL") || "qwen3-vl-embedding-2b",
      dim: Number(configValue("EMBEDDING_DIM") ?? 0),
      queryPrefix: configValue("EMBEDDING_QUERY_PREFIX") ?? DEFAULT_QUERY_PREFIX,
      minScoreMilli: Math.round(Number(configValue("EMBEDDING_MIN_SCORE") ?? 0.25) * 1000),
    },
  });
}

/** Current settings row, seeding from env on first read. Null = unconfigured
 *  (feature off: no entry points, routes 404, worker idle). */
export async function embeddingSettings(): Promise<EmbeddingSettingsRow | null> {
  const row = await prisma.embeddingSettings.findFirst();
  if (row) return row;
  try {
    return await seedFromEnv();
  } catch {
    // Racing seed (two requests on a fresh DB) — the unique-less table may get
    // two rows only via this race; findFirst keeps one authoritative.
    return prisma.embeddingSettings.findFirst();
  }
}

/** Feature availability for UI/route gating. */
export async function embeddingEnabled(): Promise<boolean> {
  const s = await embeddingSettings();
  return !!s && s.enabled && (!!s.endpoint || isEmbeddingMock());
}

export function modelConfigOf(s: EmbeddingSettingsRow): ModelConfig {
  return { endpoint: s.endpoint, apiKey: s.apiKey, model: s.model, dim: s.dim };
}

export { DEFAULT_QUERY_PREFIX };
