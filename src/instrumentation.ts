/**
 * Next.js instrumentation hook: starts the embedding worker singleton
 * (docs/SEARCH_DESIGN.md §5.3). Guarded so it never runs on the edge runtime,
 * never during `next build`, and never in dev without an explicit opt-in
 * (EMBEDDING_DEV=1 / EMBEDDING_MOCK=1 — a .env holding real endpoint values
 * must not silently start a backfill against a production GPU).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  // Notification outbox worker (docs/NOTIFICATIONS_DESIGN.md §7.3). Always
  // started (its loop idles per-poll unless push is configured — configuring
  // via the hot-reloaded config.json therefore takes effect without a
  // restart, unlike a start-time gate).
  {
    const { startNotificationWorker } = await import("./lib/notifications/worker");
    const g = globalThis as { __notifyWorker?: { stop(): void } };
    g.__notifyWorker?.stop();
    g.__notifyWorker = startNotificationWorker();
  }

  const { embeddingAllowedInThisEnv } = await import("./lib/embeddings/settings-shared");
  if (!embeddingAllowedInThisEnv()) return;
  const { startEmbeddingWorker } = await import("./lib/embeddings/worker");
  const g = globalThis as { __embedWorker?: { stop(): void } };
  // Dev hot-reload: replace the loop (stale closures must not survive).
  g.__embedWorker?.stop();
  g.__embedWorker = startEmbeddingWorker();
}
