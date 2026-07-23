import { NextResponse } from "next/server";
import { handleApi, ApiError, type ApiErrorCode } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { prisma } from "@/lib/prisma";
import { configValue } from "@/lib/config-file";
import { deployRules, rulesHealth, serviceAccountLabel } from "@/lib/esign/rules-admin";

export const runtime = "nodejs";
// The Rules API + IAM probes take a few seconds.
export const maxDuration = 30;

/**
 * Firestore rules management (docs/ESIGN_DESIGN.md §9.2, README "Managing the
 * rules"). Admin-gated.
 *
 * GET  — read-only health from the SAVED viewer key: is the deployed ruleset
 *        the canonical one, and is that saved key actually read-only?
 * POST — one-shot deploy with an EPHEMERAL admin key supplied in the body. The
 *        key is used for this request and NEVER written to config or logs; only
 *        its non-secret label (client_email) is echoed/audited.
 */

export async function GET() {
  return handleApi(async () => {
    await requireAdmin();
    const savedViewer = configValue("FIREBASE_RULES_VIEWER_JSON")?.trim();
    // Irrelevant on deployments not using Firestore at all (base app, no
    // Firebase project) — the card hides rather than nagging about rules.
    const applicable = !!configValue("FIREBASE_PROJECT_ID")?.trim() || !!savedViewer;
    const verdict = applicable ? await rulesHealth() : { status: "mock" as const };
    return NextResponse.json({
      applicable,
      verdict,
      viewerConfigured: !!savedViewer,
      viewerLabel: savedViewer ? serviceAccountLabel(savedViewer) : null,
    });
  });
}

export async function POST(req: Request) {
  return handleApi(async () => {
    const adminId = await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as { serviceAccountJson?: unknown };
    const raw = typeof body.serviceAccountJson === "string" ? body.serviceAccountJson.trim() : "";
    if (!raw) throw new ApiError(400, "Paste a service-account key to deploy with", "rules.keyMissing");

    const result = await deployRules(raw);
    if (!result.ok) {
      // Surface the machine code (client translates); include a short provider
      // detail but NEVER the key.
      throw new ApiError(
        result.code === "rules.forbidden" ? 403 : 400,
        "Rules deploy failed",
        result.code as ApiErrorCode,
        result.detail ? { detail: result.detail.slice(0, 300) } : undefined
      );
    }

    // Audit the privileged action — who, when, resulting ruleset, and the key's
    // LABEL (client_email). The key material itself is never stored or logged.
    await prisma.auditEvent.create({
      data: {
        userId: adminId,
        action: "esign-rules-deploy",
        detail: JSON.stringify({ rulesetName: result.rulesetName, keyLabel: result.keyLabel }),
      },
    });
    return NextResponse.json({ ok: true, rulesetName: result.rulesetName, keyLabel: result.keyLabel });
  });
}
