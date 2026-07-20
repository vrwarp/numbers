import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { compressReceiptImage, isSupportedUpload } from "@/lib/image";
import { saveReceiptFile } from "@/lib/storage";
import { createId } from "@paralleldrive/cuid2";
import { createHash } from "crypto";
import { enqueueReceiptEmbedding } from "@/lib/embeddings/queue";
import { enqueueReceiptAnnotation } from "@/lib/extraction/queue";

export const runtime = "nodejs";

/** List the caller's receipts (Shoebox) with the claims each one is on and
 *  the state of their background AI annotation (the card's read-status chip).
 *  ?status=unassigned|processed filters. */
export async function GET(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const status = req.nextUrl.searchParams.get("status") ?? undefined;
    const [rows, jobs] = await Promise.all([
      prisma.receipt.findMany({
        where: { userId, ...(status ? { status } : {}) },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          status: true,
          note: true,
          createdAt: true,
          merchant: true,
          extractedTotalCents: true,
          extractedRefundCents: true,
          annotatedAt: true,
          annotationSource: true,
          reimbursements: {
            select: { reimbursement: { select: { id: true, status: true, createdAt: true } } },
          },
        },
      }),
      // Only terminal failures matter here — anything else still counts as
      // "pending" (queued, running, or not yet swept in).
      prisma.extractionJob.findMany({
        where: { userId, status: "failed" },
        select: { receiptId: true, status: true },
      }),
    ]);
    const jobStatus = new Map(jobs.map((j) => [j.receiptId, j.status]));
    const receipts = rows.map(({ reimbursements, annotatedAt, annotationSource, ...r }) => ({
      ...r,
      claims: reimbursements.map((rr) => rr.reimbursement),
      // "ready" = stored annotation a claim can consume without an AI call;
      // "failed" = the worker gave up (claim creation will retry inline, and
      // degrade to a manual-entry row); "pending" = not read yet.
      annotation: annotatedAt ? "ready" : jobStatus.get(r.id) === "failed" ? "failed" : "pending",
      annotationSource,
    }));
    return NextResponse.json({ receipts });
  });
}

/**
 * Upload one or more receipt files (multipart form, field name "files").
 * Images are compressed to ~100 KB; PDFs are stored as-is. An optional
 * "note" field is stored on every receipt in the batch (editable later).
 */
export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const form = await req.formData();
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (files.length === 0) throw new ApiError(400, "No files uploaded", "noFilesUploaded");
    const note = String(form.get("note") ?? "").trim().slice(0, 300);

    const created = [];
    for (const file of files) {
      if (!isSupportedUpload(file.type)) {
        throw new ApiError(415, `Unsupported file type: ${file.type || "unknown"}`, "unsupportedFileType", { type: file.type || "unknown" });
      }
      const raw = Buffer.from(await file.arrayBuffer());
      if (raw.length === 0) throw new ApiError(400, `Empty file: ${file.name}`, "emptyFile", { name: file.name });

      let data: Buffer = raw;
      let mimeType = file.type;
      let ext = "pdf";
      if (file.type !== "application/pdf") {
        const compressed = await compressReceiptImage(raw);
        data = compressed.data;
        mimeType = compressed.mimeType;
        ext = "webp";
      }

      const id = createId();
      const filePath = await saveReceiptFile(userId, `${id}.${ext}`, data);
      const fileSha256 = createHash("sha256").update(data).digest("hex");
      const receipt = await prisma.receipt.create({
        data: { id, userId, filePath, mimeType, originalName: file.name, sizeBytes: data.length, note, fileSha256 },
        select: { id: true, originalName: true, mimeType: true, sizeBytes: true, status: true, note: true, merchant: true, createdAt: true },
      });
      // Search trigger (docs/SEARCH_DESIGN.md §5.2): index as soon as available.
      enqueueReceiptEmbedding(id, userId);
      // Background AI annotation: the worker reads the receipt (≤1/minute)
      // so claim creation later consumes the result without a provider call.
      enqueueReceiptAnnotation(id, userId);
      created.push(receipt);
    }
    return NextResponse.json({ receipts: created }, { status: 201 });
  });
}
