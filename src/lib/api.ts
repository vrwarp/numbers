import { NextResponse } from "next/server";
import { headers } from "next/headers";
import type en from "../../messages/en.json";
import { currentUserId } from "@/auth";

/**
 * A short, opaque correlation id for one request. The client records it in its
 * feedback breadcrumb ring (src/lib/feedback/capture.ts) and echoes it back on
 * every instrumented fetch as `x-request-id`; handleApi mints one when absent
 * and always returns it in the response `x-request-id` header. So a feedback
 * report can name the exact requests it rode alongside — the reproducibility
 * backbone (docs/FEEDBACK_DESIGN.md §3). Deliberately NOT stamped onto
 * ExtractionLog/AuditEvent rows: those writes live in ~20 routes and helpers
 * with no request scope; server-row join stays a documented future step.
 */
function newRequestId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  } catch {
    // crypto is present in every runtime we target; this is belt-and-suspenders.
    return `r${Date.now().toString(36)}`;
  }
}

async function resolveRequestId(): Promise<string> {
  try {
    const incoming = (await headers()).get("x-request-id");
    // Trust only a short, well-formed client id; never reflect arbitrary bytes.
    if (incoming && /^[a-zA-Z0-9_-]{1,64}$/.test(incoming)) return incoming;
  } catch {
    // headers() throws outside a request scope (shouldn't happen in handleApi).
  }
  return newRequestId();
}

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
  const requestId = await resolveRequestId();
  try {
    const res = await fn();
    // Default API responses to no-store: iOS Safari heuristically reuses
    // unmarked fetch GETs (notably across back/forward-cache restores), which
    // makes deletes/edits appear to not stick on iPhones. Routes that want
    // caching (receipt file/preview max-age) set their own header and win.
    if (res instanceof Response) {
      if (!res.headers.has("cache-control")) res.headers.set("cache-control", "no-store");
      res.headers.set("x-request-id", requestId);
    }
    return res;
  } catch (err) {
    const { body, status } = apiErrorPayload(err);
    return NextResponse.json(body, {
      status,
      headers: { "cache-control": "no-store", "x-request-id": requestId },
    });
  }
}
