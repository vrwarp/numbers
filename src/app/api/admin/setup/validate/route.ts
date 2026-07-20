import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApi, ApiError } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { isSetupService, validateService } from "@/lib/admin/validate";

export const runtime = "nodejs";
// Live provider/IAM probes can take a few seconds.
export const maxDuration = 30;

/**
 * Setup-wizard dry run (docs/ADMIN.md). Admin-gated; runs a service's checks
 * against the posted DRAFT values merged over stored config, WITHOUT
 * persisting anything — the wizard's "Test this step" action. Returns machine
 * check codes the client translates; secrets in the draft are used for the
 * probe but never echoed back.
 */

const Schema = z.object({
  service: z.string().max(40),
  values: z.record(z.string(), z.string().max(20000)).optional(),
});

export async function POST(req: NextRequest) {
  return handleApi(async () => {
    await requireAdmin();
    const parsed = Schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid validation request", "admin.invalidValidation");
    if (!isSetupService(parsed.data.service)) {
      throw new ApiError(400, "Unknown service", "admin.unknownService");
    }
    const checks = await validateService(parsed.data.service, parsed.data.values ?? {});
    const ok = !checks.some((c) => c.status === "fail");
    return NextResponse.json({ ok, checks });
  });
}
