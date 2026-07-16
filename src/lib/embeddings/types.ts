/** Shared embedding types — dependency-free (client-safe). */

/** The backend a single embed call targets. Stateless: the caller (worker,
 *  search route, probe) decides which config a call uses. */
export type ModelConfig = {
  endpoint: string;
  apiKey: string;
  model: string;
  dim: number;
};

export type EmbeddingKind = "receipt" | "claim";

export const EMBEDDING_KINDS: EmbeddingKind[] = ["receipt", "claim"];
