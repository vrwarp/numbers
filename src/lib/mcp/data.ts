import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api";
import { centsToDollarString } from "@/lib/money";

/**
 * Read models for the MCP tools (docs/MCP_DESIGN.md). SERVER ONLY (prisma).
 *
 * Every shape here is an EXPLICIT allowlist built by hand — never a spread of a
 * Prisma row — so a secret can never ride along by accident: no `publicToken`,
 * no `signatureLedger*`, no `packetSha256`, no `firebaseUid`, no file paths or
 * hashes (the app's invariant "no secrets over MCP", enforced at the boundary).
 * All reads are owner-scoped (`where: { userId }`); MCP never uses the
 * role/team cross-tenant grants — an assistant sees only its user's own data.
 * Money is returned as both integer cents (the source of truth) and a decimal
 * string for the model to read.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface Page {
  limit?: number;
  offset?: number;
  query?: string;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function clampOffset(offset: number | undefined): number {
  if (!offset || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

function money(cents: number) {
  return { cents, amount: centsToDollarString(cents) };
}

// --- Receipts ---------------------------------------------------------------

const RECEIPT_SELECT = {
  id: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  status: true,
  note: true,
  createdAt: true,
  merchant: true,
  purchaseDate: true,
  extractedTotalCents: true,
  extractedRefundCents: true,
  extractedSummary: true,
  annotatedAt: true,
  reimbursements: { select: { reimbursement: { select: { id: true, status: true } } } },
} as const;

type ReceiptRow = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  note: string;
  createdAt: Date;
  merchant: string;
  purchaseDate: string;
  extractedTotalCents: number | null;
  extractedRefundCents: number | null;
  extractedSummary: string;
  annotatedAt: Date | null;
  reimbursements: { reimbursement: { id: string; status: string } }[];
};

function receiptDto(r: ReceiptRow) {
  const total = r.extractedTotalCents ?? 0;
  const refund = r.extractedRefundCents ?? 0;
  return {
    id: r.id,
    fileName: r.originalName,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    status: r.status,
    note: r.note,
    uploadedAt: r.createdAt.toISOString(),
    merchant: r.merchant,
    purchaseDate: r.purchaseDate,
    summary: r.extractedSummary,
    // "ready" once the receipt carries an annotation a claim can consume
    // without an AI call; "pending" until the background worker reaches it.
    extraction: r.annotatedAt ? "ready" : "pending",
    // The printed totals and the net (charged − refunded) the app uses.
    printedTotal: money(total),
    printedRefund: money(refund),
    netAmount: money(total - refund),
    onClaims: r.reimbursements.map((rr) => ({ claimId: rr.reimbursement.id, status: rr.reimbursement.status })),
  };
}

export async function listReceipts(
  userId: string,
  opts: Page & { status?: string } = {}
): Promise<{ receipts: ReturnType<typeof receiptDto>[]; total: number; nextOffset: number | null }> {
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);
  const q = opts.query?.trim();
  const where = {
    userId,
    ...(opts.status ? { status: opts.status } : {}),
    ...(q
      ? {
          OR: [
            { merchant: { contains: q } },
            { note: { contains: q } },
            { originalName: { contains: q } },
            { extractedSummary: { contains: q } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.receipt.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: RECEIPT_SELECT,
      take: limit,
      skip: offset,
    }),
    prisma.receipt.count({ where }),
  ]);
  return {
    receipts: (rows as ReceiptRow[]).map(receiptDto),
    total,
    nextOffset: offset + rows.length < total ? offset + rows.length : null,
  };
}

export async function getReceipt(userId: string, receiptId: string) {
  const row = await prisma.receipt.findFirst({ where: { id: receiptId, userId }, select: RECEIPT_SELECT });
  if (!row) throw new ApiError(404, "Receipt not found", "receiptNotFound");
  return receiptDto(row as ReceiptRow);
}

// --- Claims (reimbursements) ------------------------------------------------

function claimSummaryDto(c: {
  id: string;
  status: string;
  totalCents: number;
  singleMinistry: boolean;
  claimMinistry: string;
  claimEvent: string;
  claimDescription: string;
  checkNumber: string;
  createdAt: Date;
  updatedAt: Date;
  generatedAt: Date | null;
  submittedAt: Date | null;
  decidedAt: Date | null;
  paidAt: Date | null;
  _count?: { lineItems: number; receipts: number };
}) {
  return {
    id: c.id,
    status: c.status,
    total: money(c.totalCents),
    description: c.claimDescription,
    ministry: c.claimMinistry,
    event: c.claimEvent,
    singleMinistry: c.singleMinistry,
    checkNumber: c.checkNumber || null,
    lineItemCount: c._count?.lineItems,
    receiptCount: c._count?.receipts,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    // The lifecycle timestamps a "where is my claim" question needs.
    generatedAt: c.generatedAt?.toISOString() ?? null,
    submittedAt: c.submittedAt?.toISOString() ?? null,
    decidedAt: c.decidedAt?.toISOString() ?? null,
    paidAt: c.paidAt?.toISOString() ?? null,
  };
}

export async function listClaims(
  userId: string,
  opts: Page & { status?: string } = {}
): Promise<{ claims: ReturnType<typeof claimSummaryDto>[]; total: number; nextOffset: number | null }> {
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);
  const q = opts.query?.trim();
  const where = {
    userId,
    ...(opts.status ? { status: opts.status } : {}),
    ...(q
      ? {
          OR: [
            { claimDescription: { contains: q } },
            { claimEvent: { contains: q } },
            { claimMinistry: { contains: q } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.reimbursement.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { lineItems: true, receipts: true } } },
      take: limit,
      skip: offset,
    }),
    prisma.reimbursement.count({ where }),
  ]);
  return {
    claims: rows.map(claimSummaryDto),
    total,
    nextOffset: offset + rows.length < total ? offset + rows.length : null,
  };
}

export async function getClaim(userId: string, claimId: string) {
  const c = await prisma.reimbursement.findFirst({
    where: { id: claimId, userId },
    include: {
      _count: { select: { lineItems: true, receipts: true } },
      lineItems: {
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          description: true,
          amountCents: true,
          ministry: true,
          event: true,
          isVerified: true,
          isExcluded: true,
          sortOrder: true,
          receiptId: true,
        },
      },
      receipts: {
        select: {
          receipt: {
            select: { id: true, originalName: true, merchant: true, purchaseDate: true },
          },
        },
      },
    },
  });
  if (!c) throw new ApiError(404, "Claim not found", "claimNotFound");

  const lineItems = c.lineItems.map((it) => ({
    id: it.id,
    description: it.description,
    amount: money(it.amountCents),
    ministry: it.ministry || null,
    event: it.event || null,
    isVerified: it.isVerified,
    isExcluded: it.isExcluded,
    sortOrder: it.sortOrder,
    receiptId: it.receiptId,
  }));
  const active = lineItems.filter((it) => !it.isExcluded);
  return {
    ...claimSummaryDto(c),
    // A drafting assistant needs to know exactly what still blocks the human
    // gate (invariant 3): every active row verified with a ministry.
    verification: {
      activeRows: active.length,
      verifiedRows: active.filter((it) => it.isVerified).length,
      rowsMissingMinistry: active.filter((it) => !it.ministry).length,
      readyForPdf: active.length > 0 && active.every((it) => it.isVerified && it.ministry),
    },
    lineItems,
    receipts: c.receipts.map((rr) => ({
      id: rr.receipt.id,
      fileName: rr.receipt.originalName,
      merchant: rr.receipt.merchant,
      purchaseDate: rr.receipt.purchaseDate,
    })),
  };
}

// --- Ministries (budget-category catalog) -----------------------------------

/** The active budget categories. `value` is exactly what a pick writes to a
 *  line item's `ministry` field ("<code> <name>"), so an assistant setting a
 *  ministry uses it verbatim. */
export async function listMinistries() {
  const rows = await prisma.ministry.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    select: { id: true, code: true, name: true, group: true, description: true },
  });
  return rows.map((m) => ({
    // `id` is the handle a catalog-edit draft targets; `value` is what a pick
    // writes to a line item's/claim's ministry ("<code> <name>").
    id: m.id,
    value: `${m.code} ${m.name}`,
    code: m.code,
    name: m.name,
    group: m.group || null,
    guidance: m.description || null,
  }));
}
