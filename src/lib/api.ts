import { NextResponse } from "next/server";
import { currentUserId } from "@/auth";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Resolve the authenticated user id or throw a 401 ApiError. */
export async function requireUserId(): Promise<string> {
  const userId = await currentUserId();
  if (!userId) throw new ApiError(401, "Not signed in");
  return userId;
}

/** Wrap a route handler body, converting ApiError/unknown errors to JSON responses. */
export async function handleApi<T>(fn: () => Promise<T>): Promise<NextResponse | T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("API error:", err);
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
