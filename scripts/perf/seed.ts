/**
 * Seed a realistic large dataset for performance measurement (scripts/perf/).
 * Run via scripts/perf/start-server.sh (which sets DATABASE_URL/DATA_DIR to
 * .perf-data and pushes the schema first), or standalone:
 *
 *   DATABASE_URL=file:$PWD/.perf-data/perf.db DATA_DIR=$PWD/.perf-data \
 *     npx tsx scripts/perf/seed.ts
 *
 * Scale target: a church deployment after ~2 years of heavy use, with margin —
 * one power user with hundreds of receipts/claims plus background tenants, so
 * endpoint timings surface accidental O(n²)s, N+1s and full-table scans.
 */
import { PrismaClient, type Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { MINISTRIES } from "../../src/lib/ministries";

const MAIN_EMAIL = "perf@example.com";
const MAIN_RECEIPTS = 320;
const MAIN_PDF_RECEIPTS = 12;
const OTHER_USERS = 5;
const OTHER_RECEIPTS_EACH = 60;
const DRAFT_CLAIMS = 20;
const FROZEN_CLAIMS = 24;

const dataDir = path.resolve(process.env.DATA_DIR || ".perf-data");
const prisma = new PrismaClient({
  datasourceUrl: `${process.env.DATABASE_URL}${process.env.DATABASE_URL?.includes("?") ? "&" : "?"}connection_limit=1`,
});

const MERCHANTS = [
  "Costco Wholesale",
  "Amazon",
  "Trader Joe's",
  "Home Depot",
  "Office Depot",
  "Safeway",
  "99 Ranch Market",
  "Target",
  "Smart & Final",
  "Daiso",
];

function pad(n: number, w = 3): string {
  return String(n).padStart(w, "0");
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function renderReceiptWebp(variant: number): Promise<Buffer> {
  const merchant = xmlEscape(MERCHANTS[variant % MERCHANTS.length].toUpperCase());
  const items = Array.from({ length: 6 + (variant % 5) }, (_, i) => {
    const price = ((variant * 7 + i * 13) % 9000) / 100 + 1;
    return [`ITEM ${pad(variant)}-${i} SUPPLIES`, price.toFixed(2)];
  });
  const rows = items
    .map(([left, right], i) => {
      const y = 190 + i * 42;
      return (
        `<text x="60" y="${y}" font-family="monospace" font-size="26" fill="#222">${left}</text>` +
        `<text x="740" y="${y}" font-family="monospace" font-size="26" fill="#222" text-anchor="end">${right}</text>`
      );
    })
    .join("");
  const height = 320 + items.length * 42;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${height}">
    <rect width="800" height="${height}" fill="#fdfdf6"/>
    <text x="400" y="70" font-family="monospace" font-size="32" font-weight="bold" fill="#111" text-anchor="middle">${merchant}</text>
    <text x="400" y="110" font-family="monospace" font-size="22" fill="#333" text-anchor="middle">STORE #${pad(variant, 4)}</text>
    <line x1="40" y1="140" x2="760" y2="140" stroke="#999" stroke-dasharray="6 4"/>
    ${rows}
    <line x1="40" y1="${height - 90}" x2="760" y2="${height - 90}" stroke="#999" stroke-dasharray="6 4"/>
    <text x="60" y="${height - 50}" font-family="monospace" font-size="28" fill="#111">TOTAL</text>
    <text x="740" y="${height - 50}" font-family="monospace" font-size="28" fill="#111" text-anchor="end">${((variant * 731) % 20000 / 100).toFixed(2)}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 78 }).toBuffer();
}

async function renderPdfReceipt(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`INVOICE — page ${i + 1}/${pages}`, { x: 72, y: 700, size: 20, font });
    page.drawText("Church Supply Co.", { x: 72, y: 660, size: 14, font });
    page.drawText("TOTAL  84.50", { x: 72, y: 630, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

async function seedUserReceipts(
  userId: string,
  count: number,
  pdfCount: number,
  images: Buffer[],
  pdf: Buffer
): Promise<string[]> {
  const dir = path.join(dataDir, "uploads", userId);
  await fs.mkdir(dir, { recursive: true });
  const ids: string[] = [];
  const now = Date.now();
  const rows: Prisma.ReceiptCreateManyInput[] = [];
  for (let i = 0; i < count; i++) {
    const isPdf = i < pdfCount;
    const id = `perf${userId.slice(-6)}r${pad(i, 4)}`;
    const bytes = isPdf ? pdf : images[i % images.length];
    const ext = isPdf ? "pdf" : "webp";
    await fs.writeFile(path.join(dir, `${id}.${ext}`), bytes);
    const merchant = MERCHANTS[i % MERCHANTS.length];
    const total = 500 + ((i * 977) % 25000);
    const refund = i % 9 === 0 ? Math.min(300, total) : 0;
    rows.push({
      id,
      userId,
      filePath: `uploads/${userId}/${id}.${ext}`,
      mimeType: isPdf ? "application/pdf" : "image/webp",
      originalName: isPdf ? `invoice-${pad(i)}.pdf` : `IMG_${pad(i, 4)}.jpg`,
      sizeBytes: bytes.length,
      note: i % 4 === 0 ? `Week ${1 + (i % 52)} groceries and supplies` : "",
      merchant,
      purchaseDate: `202${5 + (i % 2)}-${pad(1 + (i % 12), 2)}-${pad(1 + (i % 28), 2)}`,
      extractedTotalCents: total,
      extractedRefundCents: refund,
      extractedSummary: `paper goods, snacks, cleaning supplies (batch ${i})`,
      annotatedAt: new Date(now - i * 3_600_000),
      annotationSource: i % 17 === 0 ? "manual" : "ai",
      fileSha256: createHash("sha256").update(bytes).digest("hex"),
      createdAt: new Date(now - i * 3_600_000),
    });
    ids.push(id);
  }
  await prisma.receipt.createMany({ data: rows });
  return ids;
}

async function main() {
  const already = await prisma.user.findUnique({ where: { email: MAIN_EMAIL } });
  if (already) {
    console.log("perf seed: dataset already present, skipping");
    return;
  }
  console.time("perf seed");

  const images = await Promise.all(Array.from({ length: 12 }, (_, i) => renderReceiptWebp(i)));
  const pdf = await renderPdfReceipt(2);

  const main = await prisma.user.create({
    data: {
      email: MAIN_EMAIL,
      fullName: "Perf Main",
      mailingAddress: "123 Measurement Way\nHayward, CA 94544",
      role: "treasurer",
    },
  });

  const mainReceipts = await seedUserReceipts(
    main.id,
    MAIN_RECEIPTS,
    MAIN_PDF_RECEIPTS,
    images,
    pdf
  );

  // Background tenants: the scoping overhead every query must shrug off.
  for (let u = 0; u < OTHER_USERS; u++) {
    const user = await prisma.user.create({
      data: { email: `perf-other-${u}@example.com`, fullName: `Perf Other ${u}` },
    });
    await seedUserReceipts(user.id, OTHER_RECEIPTS_EACH, 0, images, pdf);
  }

  // Claims: drafts first (2–5 rows), then frozen ones (up to 14 rows).
  const statuses = ["generated", "submitted", "approved", "paid", "rejected"] as const;
  let cursor = 0;
  const claimIds: string[] = [];
  for (let c = 0; c < DRAFT_CLAIMS + FROZEN_CLAIMS; c++) {
    const isDraft = c < DRAFT_CLAIMS;
    const rowCount = isDraft ? 2 + (c % 4) : 3 + (c % 12);
    const receiptIds = Array.from(
      { length: rowCount },
      (_, i) => mainReceipts[(cursor + i) % mainReceipts.length]
    );
    cursor += rowCount;
    const status = isDraft ? "draft" : statuses[c % statuses.length];
    const receipts = await prisma.receipt.findMany({ where: { id: { in: receiptIds } } });
    const items = receipts.map((r, i) => {
      const amount = (r.extractedTotalCents ?? 0) - (r.extractedRefundCents ?? 0);
      const description = `${r.merchant} ${r.purchaseDate} — supplies batch ${i}`;
      return {
        receiptId: r.id,
        description,
        amountCents: amount,
        ministry: isDraft && i === 0 ? "" : MINISTRIES[(c + i) % MINISTRIES.length],
        event: i % 3 === 0 ? "Summer Retreat" : "",
        isVerified: !isDraft,
        isExcluded: !isDraft && i === rowCount - 1 && c % 5 === 0,
        sortOrder: i,
        originalDescription: description,
        originalAmountCents: amount,
      };
    });
    const totalCents = items
      .filter((it) => !it.isExcluded)
      .reduce((s, it) => s + it.amountCents, 0);
    const claim = await prisma.reimbursement.create({
      data: {
        userId: main.id,
        status,
        totalCents,
        singleMinistry: false,
        claimDescription: `Perf claim ${c} — weekly supplies`,
        generatedAt: isDraft ? null : new Date(),
        submittedAt: ["submitted", "approved", "paid"].includes(status) ? new Date() : null,
        decidedAt: ["approved", "paid", "rejected"].includes(status) ? new Date() : null,
        paidAt: status === "paid" ? new Date() : null,
        receipts: { create: receiptIds.map((receiptId) => ({ receiptId })) },
        lineItems: { create: items },
      },
    });
    claimIds.push(claim.id);
    if (!isDraft) {
      await prisma.receipt.updateMany({
        where: { id: { in: receiptIds } },
        data: { status: "processed" },
      });
    }
    // The audit + telemetry trail a claim of this age would carry.
    await prisma.auditEvent.createMany({
      data: items.slice(0, 4).map((it, i) => ({
        userId: main.id,
        reimbursementId: claim.id,
        action: "update",
        detail: JSON.stringify({
          changes: { amountCents: { from: it.amountCents + 100 * i, to: it.amountCents } },
        }),
      })),
    });
    await prisma.extractionLog.createMany({
      data: receipts.map((r) => ({
        userId: main.id,
        reimbursementId: claim.id,
        kind: "receipt",
        receiptId: r.id,
        model: "mock",
        prompt: "perf-seed prompt",
        receiptsJson: JSON.stringify([{ id: r.id, name: r.originalName }]),
        rawResponse: JSON.stringify({ merchant: r.merchant }),
        parsedJson: JSON.stringify({ merchant: r.merchant }),
        status: "success",
        durationMs: 1200,
      })),
    });
  }

  // Teams so the grant paths have data to chew on.
  const others = await prisma.user.findMany({ where: { email: { startsWith: "perf-other-" } } });
  await prisma.team.create({
    data: {
      name: "Perf Missions Team",
      members: { create: [{ userId: main.id }, { userId: others[0].id }] },
      ministries: { create: [{ code: "470" }, { code: "471" }] },
    },
  });

  const counts = {
    users: await prisma.user.count(),
    receipts: await prisma.receipt.count(),
    claims: await prisma.reimbursement.count(),
    lineItems: await prisma.lineItem.count(),
    logs: await prisma.extractionLog.count(),
  };
  console.timeEnd("perf seed");
  console.log("perf seed:", counts);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
