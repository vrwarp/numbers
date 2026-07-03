import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";

export const runtime = "nodejs";

/**
 * Full prompt-tuning record for one extraction call:
 *  - the exact prompt and raw model response
 *  - what was parsed from it
 *  - the line items as the human left them, with the original AI values and a
 *    computed `corrections` diff per item
 *  - the chronological audit trail of every manual edit
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;

    const log = await prisma.extractionLog.findFirst({ where: { id, userId } });
    if (!log) throw new ApiError(404, "Extraction log not found");

    const [lineItems, auditEvents] = await Promise.all([
      log.reimbursementId
        ? prisma.lineItem.findMany({
            where: { reimbursementId: log.reimbursementId },
            orderBy: { sortOrder: "asc" },
          })
        : Promise.resolve([]),
      log.reimbursementId
        ? prisma.auditEvent.findMany({
            where: { reimbursementId: log.reimbursementId, userId },
            orderBy: { createdAt: "asc" },
          })
        : Promise.resolve([]),
    ]);

    const items = lineItems.map((it) => {
      const corrections: Record<string, { from: unknown; to: unknown }> = {};
      if (it.originalDescription !== null && it.originalDescription !== it.description) {
        corrections.description = { from: it.originalDescription, to: it.description };
      }
      if (it.originalQuantity !== null && it.originalQuantity !== it.quantity) {
        corrections.quantity = { from: it.originalQuantity, to: it.quantity };
      }
      if (it.originalAmountCents !== null && it.originalAmountCents !== it.amountCents) {
        corrections.amountCents = { from: it.originalAmountCents, to: it.amountCents };
      }
      return {
        ...it,
        humanCreated: it.originalDescription === null,
        corrections,
      };
    });

    return NextResponse.json({
      log,
      lineItems: items,
      auditEvents: auditEvents.map((e) => ({ ...e, detail: JSON.parse(e.detail) })),
    });
  });
}
