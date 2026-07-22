import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api";
import { isAppAdmin } from "@/lib/config";
import {
  listAdminFeedback,
  getAdminFeedback,
  setFeedbackStatus,
  FEEDBACK_STATUSES,
  type AdminFeedbackRow,
} from "@/lib/feedback/server";
import { shortRef } from "@/lib/feedback/types";

/**
 * Feedback triage for the MCP backend (docs/MCP_DESIGN.md). SERVER ONLY.
 *
 * Feedback reports carry free-text PII, so viewing them is the same §6.3-style
 * admin read grant the admin triage UI uses (invariant 13) — every tool here
 * requires the caller to be an app-admin (verified role OR ADMIN_EMAILS,
 * honoring the A10 admin pause), on top of the token's `feedback:*` scope. The
 * list stays lean (no diagnostics); the single-report view carries the redacted
 * diagnostics the admin UI shows. Screenshot BYTES are never returned — only a
 * `hasScreenshot` flag (the image is served by its own admin route).
 */

async function requireFeedbackAdmin(userId: string): Promise<void> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, role: true, adminPaused: true },
  });
  if (!u || !isAppAdmin(u)) {
    throw new ApiError(
      403,
      "Viewing feedback reports requires an admin role, which this account does not have.",
      "feedbackRoleRequired"
    );
  }
}

/** Triage summary — everything the queue needs, no diagnostics bundle. */
function summary(r: AdminFeedbackRow) {
  return {
    id: r.id,
    ref: shortRef(r.id),
    category: r.category,
    situation: r.situation || null,
    status: r.status,
    message: r.message,
    route: r.route || null,
    reporter: r.reporter,
    hasScreenshot: r.hasScreenshot,
    createdAt: r.createdAt,
  };
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 25;
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

export async function mcpListFeedback(
  userId: string,
  opts: { status?: string; limit?: number } = {}
) {
  await requireFeedbackAdmin(userId);
  const rows = await listAdminFeedback(opts.status);
  const limit = clampLimit(opts.limit);
  return { reports: rows.slice(0, limit).map(summary), total: rows.length };
}

export async function mcpGetFeedback(userId: string, id: string) {
  await requireFeedbackAdmin(userId);
  const r = await getAdminFeedback(id);
  if (!r) throw new ApiError(404, "Feedback report not found.", "feedbackNotFound");
  // Full detail: summary + the redacted diagnostics + build/agent context.
  return {
    ...summary(r),
    buildSha: r.buildSha || null,
    locale: r.locale,
    userAgent: r.userAgent || null,
    diagnostics: r.diagnostics,
  };
}

export async function mcpSetFeedbackStatus(userId: string, id: string, status: string) {
  await requireFeedbackAdmin(userId);
  if (!(FEEDBACK_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError(400, `Status must be one of: ${FEEDBACK_STATUSES.join(", ")}.`, "feedbackInvalid");
  }
  // setFeedbackStatus throws 404 if the report is gone.
  const next = await setFeedbackStatus(id, status);
  return { id, status: next };
}
