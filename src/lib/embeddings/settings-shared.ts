import { configValue } from "@/lib/config-file";

/** Small flag helpers shared by provider/settings/worker (SERVER ONLY). */

export function isEmbeddingMock(): boolean {
  return configValue("EMBEDDING_MOCK") === "1";
}

/** In dev, the env seed + worker require an explicit opt-in so a .env holding
 *  real endpoint values never silently starts a backfill against a production
 *  GPU from a laptop (docs/SEARCH_DESIGN.md §3.2). Mock mode is always allowed. */
export function embeddingAllowedInThisEnv(): boolean {
  if (isEmbeddingMock()) return true;
  if (process.env.NODE_ENV === "development") return configValue("EMBEDDING_DEV") === "1";
  return true;
}
