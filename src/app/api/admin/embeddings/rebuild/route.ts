import { NextResponse } from "next/server";
import { handleApi } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { prisma } from "@/lib/prisma";
import { kickSweep } from "@/lib/embeddings/worker";

export const runtime = "nodejs";

/** "Rebuild index" (docs/SEARCH_DESIGN.md §10): forced-staleness sweep on the
 *  current model — the hammer for "the endpoint was silently swapped under
 *  me". Kicks synchronously so progress starts before the admin's eyes. */
export async function POST() {
  return handleApi(async () => {
    const adminId = await requireAdmin();
    const { enqueued } = await kickSweep(true);
    await prisma.auditEvent.create({
      data: {
        userId: adminId,
        action: "rebuild-embeddings",
        detail: JSON.stringify({ enqueued }),
      },
    });
    return NextResponse.json({ ok: true, enqueued });
  });
}
