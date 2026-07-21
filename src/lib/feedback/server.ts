import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api";
import { FEEDBACK_CATEGORIES, MESSAGE_MAX, type FeedbackCategory } from "./types";

/**
 * Feedback persistence (docs/FEEDBACK_DESIGN.md §4). SERVER ONLY. The client
 * already redacted the diagnostics bundle; the server's job is to validate,
 * bound sizes (a hostile/buggy client can't bloat the DB), rate-cap, and store.
 * Writing a report is fire-and-forget from the app's perspective — it never
 * touches a claim/receipt mutation.
 */

const ROUTE_MAX = 200;
const BUILD_MAX = 80;
const LOCALE_MAX = 16;
const UA_MAX = 400;
// Serialized diagnostics ceiling: breadcrumbs are capped at 25 shape-only
// entries client-side, so this is generous headroom, not the primary limit.
const DIAGNOSTICS_MAX = 24_000;

// A member can file at most this many reports per rolling hour. A crash loop or
// a stuck finger can't spam the queue; a genuine reporter never hits it.
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 30;

export interface FeedbackInput {
  category?: unknown;
  situation?: unknown;
  message?: unknown;
  route?: unknown;
  buildSha?: unknown;
  locale?: unknown;
  diagnostics?: unknown;
}

function str(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeCategory(value: unknown): FeedbackCategory {
  return FEEDBACK_CATEGORIES.includes(value as FeedbackCategory)
    ? (value as FeedbackCategory)
    : "bug";
}

/** Re-serialize the diagnostics object under a hard byte ceiling. Non-objects
 *  and oversized bundles degrade gracefully rather than failing the report. */
function normalizeDiagnostics(value: unknown): string {
  if (value == null || typeof value !== "object") return "{}";
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return "{}";
  }
  if (json.length <= DIAGNOSTICS_MAX) return json;
  // Too big: keep the envelope, drop the breadcrumbs (the only unbounded part).
  try {
    const obj = value as Record<string, unknown>;
    const trimmed = { ...obj, breadcrumbs: [], breadcrumbsTruncated: true };
    const out = JSON.stringify(trimmed);
    return out.length <= DIAGNOSTICS_MAX ? out : "{}";
  } catch {
    return "{}";
  }
}

export async function createFeedbackReport(
  userId: string,
  input: FeedbackInput
): Promise<{ id: string }> {
  const message = str(input.message, MESSAGE_MAX);
  const userAgent = str(
    input.diagnostics && typeof input.diagnostics === "object"
      ? (input.diagnostics as { env?: { ua?: unknown } }).env?.ua
      : "",
    UA_MAX
  );

  const since = new Date(Date.now() - RATE_WINDOW_MS);
  const recent = await prisma.feedbackReport.count({
    where: { userId, createdAt: { gte: since } },
  });
  if (recent >= RATE_MAX) {
    throw new ApiError(429, "Too many reports — please try again later", "feedbackRateLimited");
  }

  const report = await prisma.feedbackReport.create({
    data: {
      userId,
      category: normalizeCategory(input.category),
      situation: str(input.situation, 40),
      message,
      route: str(input.route, ROUTE_MAX),
      buildSha: str(input.buildSha, BUILD_MAX),
      diagnosticsJson: normalizeDiagnostics(input.diagnostics),
      locale: str(input.locale, LOCALE_MAX) || "en",
      userAgent,
    },
    select: { id: true },
  });
  return report;
}

export interface OwnFeedbackRow {
  id: string;
  category: string;
  message: string;
  status: string;
  createdAt: string;
}

/** The reporter's own recent reports — the closed-loop "Profile › Feedback"
 *  list. Owner-scoped (invariant 2); no diagnostics returned. */
export async function listOwnFeedback(userId: string): Promise<OwnFeedbackRow[]> {
  const rows = await prisma.feedbackReport.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { id: true, category: true, message: true, status: true, createdAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    message: r.message,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  }));
}

export const FEEDBACK_STATUSES = ["new", "triaged", "closed"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export interface AdminFeedbackRow {
  id: string;
  category: string;
  situation: string;
  message: string;
  route: string;
  buildSha: string;
  locale: string;
  userAgent: string;
  status: string;
  createdAt: string;
  reporter: string;
  diagnostics: unknown;
}

/** The admin triage queue: ALL reports (a §6.3-style read grant beside
 *  invariant 2 — reports can carry free-text PII, so this is admin-gated by the
 *  caller). Optional status filter. Diagnostics parsed for display. */
export async function listAdminFeedback(status?: string): Promise<AdminFeedbackRow[]> {
  const where =
    status && (FEEDBACK_STATUSES as readonly string[]).includes(status) ? { status } : {};
  const rows = await prisma.feedbackReport.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { user: { select: { email: true, fullName: true } } },
  });
  return rows.map((r) => {
    let diagnostics: unknown = null;
    try {
      diagnostics = JSON.parse(r.diagnosticsJson);
    } catch {
      diagnostics = null;
    }
    return {
      id: r.id,
      category: r.category,
      situation: r.situation,
      message: r.message,
      route: r.route,
      buildSha: r.buildSha,
      locale: r.locale,
      userAgent: r.userAgent,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      reporter: r.user.fullName || r.user.email,
      diagnostics,
    };
  });
}

/** Admin-only triage transition. Returns the new status. */
export async function setFeedbackStatus(id: string, status: string): Promise<FeedbackStatus> {
  if (!(FEEDBACK_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError(400, "Invalid status", "feedbackInvalid");
  }
  const updated = await prisma.feedbackReport
    .update({ where: { id }, data: { status }, select: { status: true } })
    .catch(() => null);
  if (!updated) throw new ApiError(404, "Not found");
  return updated.status as FeedbackStatus;
}
