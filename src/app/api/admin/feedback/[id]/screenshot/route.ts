import { handleApi, ApiError } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { feedbackScreenshotPath } from "@/lib/feedback/server";
import { readFeedbackScreenshot } from "@/lib/feedback/storage";

export const runtime = "nodejs";

/**
 * Serve an opt-in feedback screenshot (docs/FEEDBACK_DESIGN.md §5). Admin-gated
 * (404 for everyone else, like the rest of /api/admin). Private, no-store.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    await requireAdmin();
    const { id } = await params;
    const rel = await feedbackScreenshotPath(id);
    const file = rel ? readFeedbackScreenshot(rel) : null;
    if (!file) throw new ApiError(404, "Not found");
    return new Response(new Uint8Array(file.bytes), {
      headers: { "content-type": file.contentType, "cache-control": "private, no-store" },
    });
  });
}
