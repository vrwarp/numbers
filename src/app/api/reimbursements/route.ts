import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { extractLineItems } from "@/lib/ai/extract";
import { parseDollarsToCents } from "@/lib/money";
import { MINISTRIES } from "@/lib/config";

export const runtime = "nodejs";
// AI extraction on a large batch can take a while.
export const maxDuration = 300;

export async function GET() {
  return handleApi(async () => {
    const userId = await requireUserId();
    const reimbursements = await prisma.reimbursement.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { lineItems: true, receipts: true } } },
    });
    return NextResponse.json({ reimbursements });
  });
}

const CreateSchema = z.object({ receiptIds: z.array(z.string().min(1)).min(1) });

/**
 * "Generate Claim": batch the selected shoebox receipts through the LLM and
 * create a draft reimbursement with unverified line items.
 */
export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const body = CreateSchema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, "receiptIds (non-empty array) required");
    const receiptIds = [...new Set(body.data.receiptIds)];

    const receipts = await prisma.receipt.findMany({ where: { id: { in: receiptIds }, userId } });
    if (receipts.length !== receiptIds.length) {
      throw new ApiError(404, "One or more receipts were not found");
    }
    const alreadyUsed = receipts.filter((r) => r.status !== "unassigned");
    if (alreadyUsed.length > 0) {
      throw new ApiError(409, `Already used in a claim: ${alreadyUsed.map((r) => r.originalName).join(", ")}`);
    }

    let extracted;
    try {
      extracted = await extractLineItems(receipts);
    } catch (err) {
      const message = err instanceof Error ? err.message : "extraction failed";
      throw new ApiError(502, `AI extraction failed: ${message}`);
    }

    const ministrySet = new Set<string>(MINISTRIES);
    const items = extracted.map((item, i) => ({
      receiptId: item.receiptId,
      description: item.description,
      quantity: item.quantity,
      amountCents: parseDollarsToCents(item.amount),
      ministry: ministrySet.has(item.suggestedMinistry) ? item.suggestedMinistry : "General Fund",
      sortOrder: i,
    }));
    const totalCents = items.reduce((s, it) => s + it.amountCents, 0);

    const reimbursement = await prisma.reimbursement.create({
      data: {
        userId,
        totalCents,
        receipts: { create: receiptIds.map((receiptId) => ({ receiptId })) },
        lineItems: { create: items },
      },
      include: { lineItems: true },
    });

    return NextResponse.json({ reimbursement }, { status: 201 });
  });
}
