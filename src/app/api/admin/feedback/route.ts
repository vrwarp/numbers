import { NextResponse, type NextRequest } from "next/server";
import { handleApi, ApiError } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { listAdminFeedback, setFeedbackStatus } from "@/lib/feedback/server";

export const runtime = "nodejs";

/**
 * Admin feedback triage (docs/FEEDBACK_DESIGN.md §4). Admin-gated (404 for
 * everyone else, like the rest of /api/admin). GET lists reports (optional
 * ?status=); PATCH moves one through new → triaged → closed.
 */
export async function GET(req: NextRequest) {
  return handleApi(async () => {
    await requireAdmin();
    const status = req.nextUrl.searchParams.get("status") ?? undefined;
    const reports = await listAdminFeedback(status);
    return NextResponse.json({ reports });
  });
}

export async function PATCH(req: NextRequest) {
  return handleApi(async () => {
    await requireAdmin();
    const body = (await req.json().catch(() => null)) as { id?: unknown; status?: unknown } | null;
    if (!body || typeof body.id !== "string" || typeof body.status !== "string") {
      throw new ApiError(400, "Invalid status update", "feedbackInvalid");
    }
    const status = await setFeedbackStatus(body.id, body.status);
    return NextResponse.json({ ok: true, status });
  });
}
