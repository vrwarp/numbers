import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshTestDb, removeTestDb } from "./db";

/**
 * DB-backed coverage of src/lib/claims.ts — the claim-building machinery the
 * e2e suite exercises only through its happy paths. Runs on a real SQLite
 * database (see ./db.ts); AI extraction uses AI_MOCK, with vi.doMock swapping
 * in failure outcomes for the branches the mock has no lever for.
 */

const { dir } = freshTestDb("claims");
process.env.AI_MOCK = "1";

// Loaded dynamically AFTER env points at the test db (prisma captures
// DATABASE_URL at first import).
type Prisma = typeof import("@/lib/prisma")["prisma"];
type Claims = typeof import("@/lib/claims");
let prisma: Prisma;
let claims: Claims;
let userId: string;

async function makeReceipt(
  name: string,
  extra: Partial<{
    merchant: string;
    purchaseDate: string;
    extractedTotalCents: number;
    extractedRefundCents: number;
    extractedSummary: string;
    annotatedAt: Date;
    annotationSource: string;
    note: string;
  }> = {}
) {
  return prisma.receipt.create({
    data: {
      userId,
      filePath: `uploads/${userId}/${name}`,
      mimeType: "image/webp",
      originalName: name,
      sizeBytes: 1000,
      ...extra,
    },
  });
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  claims = await import("@/lib/claims");
  const user = await prisma.user.create({
    data: { email: "claims-int@example.com", fullName: "Int Test" },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  removeTestDb(dir);
});

describe("createDraftClaim", () => {
  it("consumes stored AI annotations with no provider call, freezing original*", async () => {
    const r = await makeReceipt("annotated.jpg", {
      merchant: "Trader Joe's",
      purchaseDate: "2026-05-01",
      extractedTotalCents: 1234,
      extractedRefundCents: 200,
      extractedSummary: "flowers",
      annotatedAt: new Date(),
      annotationSource: "ai",
      note: "week 1 flowers",
    });
    // A background-annotation log not yet linked to any claim: creation must
    // ADOPT it so per-claim telemetry stays complete (invariant 7).
    const bgLog = await prisma.extractionLog.create({
      data: {
        userId,
        kind: "receipt",
        receiptId: r.id,
        model: "mock",
        prompt: "p",
        status: "success",
        durationMs: 5,
      },
    });

    const created = await claims.createDraftClaim(userId, [r], "ai");

    expect(created.status).toBe("draft");
    expect(created.lineItems).toHaveLength(1);
    const item = created.lineItems[0];
    expect(item.amountCents).toBe(1034); // 1234 − 200
    expect(item.description).toContain("Trader Joe's");
    expect(item.ministry).toBe(""); // the AI never assigns a ministry
    expect(item.isVerified).toBe(false);
    expect(item.originalDescription).toBe(item.description); // frozen AI snapshot
    expect(item.originalAmountCents).toBe(1034);
    expect(created.totalCents).toBe(1034);
    // Single-receipt claims adopt the receipt note as the claim description.
    expect(created.claimDescription).toBe("week 1 flowers");

    const adopted = await prisma.extractionLog.findUnique({ where: { id: bgLog.id } });
    expect(adopted?.reimbursementId).toBe(created.id);
    // No fresh AI call happened, so the adopted background log is the only one.
    const logs = await prisma.extractionLog.findMany({ where: { reimbursementId: created.id } });
    expect(logs).toHaveLength(1);
  });

  it("leaves original* NULL when the stored annotation is human-typed", async () => {
    const r = await makeReceipt("manual-annotated.jpg", {
      merchant: "Hand Typed",
      extractedTotalCents: 500,
      extractedRefundCents: 0,
      annotatedAt: new Date(),
      annotationSource: "manual",
    });
    const created = await claims.createDraftClaim(userId, [r], "ai");
    const item = created.lineItems[0];
    expect(item.amountCents).toBe(500);
    expect(item.originalDescription).toBeNull();
    expect(item.originalAmountCents).toBeNull();
  });

  it("extracts never-annotated receipts inline (mock), stamping the annotation + logging the call", async () => {
    const r = await makeReceipt("fresh-costco.jpg");
    const created = await claims.createDraftClaim(userId, [r], "ai");
    const item = created.lineItems[0];
    expect(item.amountCents).toBe(10210); // mock: $102.10
    expect(item.originalAmountCents).toBe(10210);
    expect(created.totalCents).toBe(10210);

    const stamped = await prisma.receipt.findUnique({ where: { id: r.id } });
    expect(stamped?.merchant).toBe("Costco Wholesale");
    expect(stamped?.annotatedAt).not.toBeNull();
    expect(stamped?.annotationSource).toBe("ai");

    const logs = await prisma.extractionLog.findMany({ where: { reimbursementId: created.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("success");
    expect(logs[0].receiptId).toBe(r.id);
  });

  it("degrades an unreadable receipt to a blank manual-entry row without failing the batch", async () => {
    const good = await makeReceipt("good.jpg");
    const bad = await makeReceipt("unreadable.jpg"); // mock throws for this name
    const created = await claims.createDraftClaim(userId, [good, bad], "ai");

    expect(created.lineItems).toHaveLength(2);
    const badItem = created.lineItems.find((i) => i.receiptId === bad.id)!;
    expect(badItem.description).toBe("");
    expect(badItem.amountCents).toBe(0);
    expect(badItem.originalDescription).toBeNull();
    expect(badItem.isVerified).toBe(false);
    // The failure is telemetry-logged against the claim.
    const logs = await prisma.extractionLog.findMany({ where: { reimbursementId: created.id } });
    expect(logs.map((l) => l.status).sort()).toEqual(["error", "success"]);
    // The unreadable receipt was NOT stamped as annotated.
    const badRow = await prisma.receipt.findUnique({ where: { id: bad.id } });
    expect(badRow?.annotatedAt).toBeNull();
  });

  it("manual mode makes all-blank rows with no AI call and no logs", async () => {
    const r = await makeReceipt("manual-mode.jpg", {
      merchant: "Ignored",
      extractedTotalCents: 999,
      annotatedAt: new Date(),
      annotationSource: "ai",
    });
    const created = await claims.createDraftClaim(userId, [r], "manual");
    expect(created.lineItems[0].description).toBe("");
    expect(created.lineItems[0].amountCents).toBe(0);
    expect(created.totalCents).toBe(0);
    const logs = await prisma.extractionLog.findMany({ where: { reimbursementId: created.id } });
    expect(logs).toHaveLength(0);
  });

  it("stored mode consumes annotations and blanks the rest — never calls the provider", async () => {
    const annotated = await makeReceipt("stored-annotated.jpg", {
      merchant: "Stored",
      extractedTotalCents: 700,
      extractedRefundCents: 0,
      annotatedAt: new Date(),
      annotationSource: "ai",
    });
    const pending = await makeReceipt("stored-pending.jpg");
    const created = await claims.createDraftClaim(userId, [annotated, pending], "stored");
    const byReceipt = new Map(created.lineItems.map((i) => [i.receiptId, i]));
    expect(byReceipt.get(annotated.id)?.amountCents).toBe(700);
    expect(byReceipt.get(pending.id)?.amountCents).toBe(0);
    expect(byReceipt.get(pending.id)?.description).toBe("");
    // stored mode never extracts, so the pending receipt stays unannotated.
    const row = await prisma.receipt.findUnique({ where: { id: pending.id } });
    expect(row?.annotatedAt).toBeNull();
  });
});

describe("extractClaimRows quota failures", () => {
  it("throws 429 all-or-nothing and logs EVERY call when the provider is rate-limited", async () => {
    vi.resetModules();
    vi.doMock("@/lib/ai/extract", () => ({
      EXTRACTION_CONCURRENCY: 3,
      extractReceipts: async (receipts: { id: string; originalName: string }[]) =>
        receipts.map((receipt, i) => ({
          receipt,
          result: null,
          error: i === 0 ? "Provider returned 429: rate limit exceeded" : "some other failure",
          meta: {
            model: "mock",
            prompt: "p",
            receiptsJson: "[]",
            rawResponse: null,
            durationMs: 1,
          },
        })),
    }));
    const mocked = await import("@/lib/claims");
    const { ApiError } = await import("@/lib/api");

    const a = await makeReceipt("quota-a.jpg");
    const b = await makeReceipt("quota-b.jpg");
    const before = await prisma.reimbursement.count({ where: { userId } });

    let thrown: unknown;
    try {
      await mocked.createDraftClaim(userId, [a, b], "ai");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as InstanceType<typeof ApiError>).status).toBe(429);

    // No claim was created…
    expect(await prisma.reimbursement.count({ where: { userId } })).toBe(before);
    // …but both calls were telemetry-logged (success AND failure duty).
    const logs = await prisma.extractionLog.findMany({
      where: { receiptId: { in: [a.id, b.id] } },
    });
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.status === "error")).toBe(true);

    vi.doUnmock("@/lib/ai/extract");
    vi.resetModules();
    // Restore the real module bindings for the remaining tests.
    claims = await import("@/lib/claims");
    ({ prisma } = await import("@/lib/prisma"));
  });
});

describe("addReceiptsToClaim", () => {
  it("appends rows after existing sortOrder, inherits single-ministry values, audits, recomputes total", async () => {
    const first = await makeReceipt("add-first.jpg", {
      merchant: "First",
      extractedTotalCents: 1000,
      extractedRefundCents: 0,
      annotatedAt: new Date(),
      annotationSource: "ai",
    });
    const created = await claims.createDraftClaim(userId, [first], "ai");
    await prisma.reimbursement.update({
      where: { id: created.id },
      data: { singleMinistry: true, claimMinistry: "245 Drinking Water", claimEvent: "Retreat" },
    });

    const extra = await makeReceipt("add-extra.jpg", {
      merchant: "Extra",
      extractedTotalCents: 2500,
      extractedRefundCents: 500,
      annotatedAt: new Date(),
      annotationSource: "ai",
    });
    const resolved = await claims.resolveReceiptsToAdd(userId, created.id, [extra.id]);
    const totalCents = await claims.addReceiptsToClaim(userId, created.id, resolved, "ai");

    expect(totalCents).toBe(1000 + 2000);
    const rows = await prisma.lineItem.findMany({
      where: { reimbursementId: created.id },
      orderBy: { sortOrder: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[1].receiptId).toBe(extra.id);
    expect(rows[1].sortOrder).toBeGreaterThan(rows[0].sortOrder);
    // Single-ministry mode stamps the claim-level pick onto appended rows.
    expect(rows[1].ministry).toBe("245 Drinking Water");
    expect(rows[1].event).toBe("Retreat");

    const audit = await prisma.auditEvent.findMany({
      where: { reimbursementId: created.id, action: "add-receipt" },
    });
    expect(audit).toHaveLength(1);
    const detail = JSON.parse(audit[0].detail);
    expect(detail.addedReceipts[0].receiptId).toBe(extra.id);

    const claim = await prisma.reimbursement.findUnique({ where: { id: created.id } });
    expect(claim?.totalCents).toBe(3000);
  });

  it("refuses duplicates and non-draft claims via resolveReceiptsToAdd", async () => {
    const { ApiError } = await import("@/lib/api");
    const r = await makeReceipt("dup.jpg", {
      annotatedAt: new Date(),
      annotationSource: "ai",
      extractedTotalCents: 100,
      extractedRefundCents: 0,
    });
    const created = await claims.createDraftClaim(userId, [r], "ai");

    await expect(
      claims.resolveReceiptsToAdd(userId, created.id, [r.id])
    ).rejects.toMatchObject({ status: 409 });

    await prisma.reimbursement.update({ where: { id: created.id }, data: { status: "generated" } });
    const other = await makeReceipt("dup-other.jpg");
    await expect(
      claims.resolveReceiptsToAdd(userId, created.id, [other.id])
    ).rejects.toMatchObject({ status: 409 });

    // Foreign claim → 404, not 403 (cross-tenant invariant).
    const stranger = await prisma.user.create({ data: { email: "stranger@example.com" } });
    await expect(
      claims.resolveReceiptsToAdd(stranger.id, created.id, [other.id])
    ).rejects.toMatchObject({ status: 404 });
    expect(ApiError).toBeDefined();
  });

  it("resolveClaimReceipts 404s on foreign or unknown receipt ids", async () => {
    const mine = await makeReceipt("resolve-mine.jpg");
    const stranger = await prisma.user.create({ data: { email: "stranger2@example.com" } });
    const theirs = await prisma.receipt.create({
      data: {
        userId: stranger.id,
        filePath: `uploads/${stranger.id}/theirs.jpg`,
        mimeType: "image/webp",
        originalName: "theirs.jpg",
        sizeBytes: 10,
      },
    });
    await expect(
      claims.resolveClaimReceipts(userId, [mine.id, theirs.id])
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      claims.resolveClaimReceipts(userId, ["nonexistent-id"])
    ).rejects.toMatchObject({ status: 404 });
    // Duplicate selections collapse rather than double-create.
    const ok = await claims.resolveClaimReceipts(userId, [mine.id, mine.id]);
    expect(ok).toHaveLength(1);
  });
});
