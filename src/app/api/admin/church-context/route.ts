import { NextResponse } from "next/server";
import { handleApi, ApiError } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { prisma } from "@/lib/prisma";
import {
  CHURCH_CONTEXT_MAX_BYTES,
  churchContextPath,
  readChurchContextRaw,
  writeChurchContext,
} from "@/lib/church-context";

export const runtime = "nodejs";

/**
 * The operator-authored church vocabulary doc fed into ministry suggestions
 * (docs/ADMIN.md — the main admin job). Previously editable only by hand on the
 * /data volume; now editable in-app, hot-reloaded (loadChurchContext reads
 * fresh on every suggestion). Admin-gated + audited.
 */

export async function GET() {
  return handleApi(async () => {
    await requireAdmin();
    const content = (await readChurchContextRaw()) ?? "";
    return NextResponse.json({
      content,
      path: churchContextPath(),
      maxBytes: CHURCH_CONTEXT_MAX_BYTES,
      bytes: Buffer.byteLength(content, "utf8"),
    });
  });
}

export async function PUT(req: Request) {
  return handleApi(async () => {
    const adminId = await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as { content?: unknown };
    if (typeof body.content !== "string") {
      throw new ApiError(400, "content must be a string", "admin.contentString");
    }
    const bytes = Buffer.byteLength(body.content, "utf8");
    if (bytes > CHURCH_CONTEXT_MAX_BYTES) {
      throw new ApiError(400, "Church context is too long", "admin.contextTooLong", {
        max: CHURCH_CONTEXT_MAX_BYTES,
      });
    }
    await writeChurchContext(body.content);
    await prisma.auditEvent.create({
      data: {
        userId: adminId,
        action: "admin-church-context",
        detail: JSON.stringify({ bytes, cleared: body.content.trim() === "" }),
      },
    });
    return NextResponse.json({ ok: true, bytes });
  });
}
