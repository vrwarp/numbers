import { NextResponse } from "next/server";
import type en from "../../messages/en.json";
import { currentUserId } from "@/auth";

/**
 * Error codes are compile-checked against the Errors.* catalog: a code with
 * no catalog entry (or a typo) fails `npm run build`, same as a bad t() key.
 * Type-only import — nothing from en.json reaches the runtime bundle here.
 */
type ErrorsCatalog = (typeof en)["Errors"];
/** Flat keys, plus one dotted level for grouped codes (e.g. "esign.notEnrolled"). */
export type ApiErrorCode = {
  [K in keyof ErrorsCatalog]: ErrorsCatalog[K] extends string
    ? K
    : `${K & string}.${keyof ErrorsCatalog[K] & string}`;
}[keyof ErrorsCatalog];

/**
 * `message` stays English (logs, curl, and the client's last-resort display);
 * `code` + `params` are the machine-readable identity a localized client maps
 * to its own catalog (Errors.* — see src/lib/use-api-error.ts). Codes are
 * part of the API contract: rename only with the catalogs.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: ApiErrorCode,
    public params?: Record<string, string | number>
  ) {
    super(message);
  }
}

/** Resolve the authenticated user id or throw a 401 ApiError. */
export async function requireUserId(): Promise<string> {
  const userId = await currentUserId();
  if (!userId) throw new ApiError(401, "Not signed in", "notSignedIn");
  return userId;
}

/** The `{error, code?, params?}` JSON body for a thrown error (shared with
 *  claims.ts's pre-stream path). Unknown errors carry no code on purpose —
 *  their raw English message is the most useful thing to show. */
export function apiErrorPayload(err: unknown): { body: object; status: number } {
  if (err instanceof ApiError) {
    return {
      body: {
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
        ...(err.params ? { params: err.params } : {}),
      },
      status: err.status,
    };
  }
  console.error("API error:", err);
  const message = err instanceof Error ? err.message : "Internal error";
  return { body: { error: message }, status: 500 };
}

/** Wrap a route handler body, converting ApiError/unknown errors to JSON responses. */
export async function handleApi<T>(fn: () => Promise<T>): Promise<NextResponse | T> {
  try {
    return await fn();
  } catch (err) {
    const { body, status } = apiErrorPayload(err);
    return NextResponse.json(body, { status });
  }
}
