import { NextResponse, type NextRequest } from "next/server";
import { handleApi, requireUserId, ApiError } from "@/lib/api";
import { createFeedbackReport, listOwnFeedback } from "@/lib/feedback/server";
import { shortRef } from "@/lib/feedback/types";

export const runtime = "nodejs";

/**
 * User feedback / bug reports (docs/FEEDBACK_DESIGN.md). Every user may file;
 * owner-scoped like everything else. POST stores one report (rate-capped);
 * GET returns the caller's own recent reports for the closed-loop status list.
 */
export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new ApiError(400, "Invalid feedback", "feedbackInvalid");
    }
    const { id } = await createFeedbackReport(userId, body as Record<string, unknown>);
    return NextResponse.json({ ok: true, id, ref: shortRef(id) }, { status: 201 });
  });
}

export async function GET() {
  return handleApi(async () => {
    const userId = await requireUserId();
    const reports = await listOwnFeedback(userId);
    return NextResponse.json({ reports });
  });
}
