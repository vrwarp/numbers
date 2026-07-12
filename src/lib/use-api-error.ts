"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";

interface ApiErrorBody {
  error?: string;
  code?: string;
  params?: Record<string, string | number>;
}

/**
 * Translate a server error body (`{error, code?, params?}` — src/lib/api.ts).
 * Known code → the localized Errors.* message; unknown/absent code → the raw
 * English `error` text (better than hiding it); nothing at all → the caller's
 * contextual fallback. Also accepts the NDJSON stream's error line, which
 * carries `message` instead of `error`.
 */
export function useApiErrorMessage() {
  const t = useTranslations("Errors");
  // Stable identity: callers keep it in useCallback/useEffect dependencies.
  return useCallback(
    (body: unknown, fallback: string): string => {
      const b = (body ?? {}) as ApiErrorBody & { message?: string };
      // Server codes are dynamic strings, so they can't satisfy the typed
      // catalog signature — the runtime t.has() guard is the check that matters.
      const tDynamic = t as unknown as ((key: string, params?: Record<string, string | number>) => string) & {
        has: (key: string) => boolean;
      };
      if (b.code && tDynamic.has(b.code)) {
        return tDynamic(b.code, b.params);
      }
      return b.error ?? b.message ?? fallback;
    },
    [t]
  );
}

/**
 * Translate a THROWN error (the e-sign ceremony paths throw instead of
 * returning response bodies). A server payload attached by jsonOrThrow
 * (src/lib/esign/client.ts) goes through the code→Errors.* lookup above;
 * a plain client-side Error keeps its own message (protocol/audit texts
 * are deliberately English); anything else gets the caller's fallback.
 */
export function useThrownErrorMessage() {
  const apiError = useApiErrorMessage();
  return useCallback(
    (err: unknown, fallback: string): string => {
      const payload = (err as { payload?: unknown } | null)?.payload;
      if (payload) return apiError(payload, fallback);
      if (err instanceof Error && err.message) return err.message;
      return fallback;
    },
    [apiError]
  );
}
