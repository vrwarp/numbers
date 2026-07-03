import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { compressReceiptImage, isSupportedUpload } from "@/lib/image";
import { saveReceiptFile } from "@/lib/storage";
import { createId } from "@paralleldrive/cuid2";

export const runtime = "nodejs";

/** List the caller's receipts (Shoebox). ?status=unassigned|processed filters. */
export async function GET(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const status = req.nextUrl.searchParams.get("status") ?? undefined;
    const receipts = await prisma.receipt.findMany({
      where: { userId, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
      select: { id: true, originalName: true, mimeType: true, sizeBytes: true, status: true, createdAt: true },
    });
    return NextResponse.json({ receipts });
  });
}

/**
 * Upload one or more receipt files (multipart form, field name "files").
 * Images are compressed to ~100 KB; PDFs are stored as-is.
 */
export async function POST(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const form = await req.formData();
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (files.length === 0) throw new ApiError(400, "No files uploaded");

    const created = [];
    for (const file of files) {
      if (!isSupportedUpload(file.type)) {
        throw new ApiError(415, `Unsupported file type: ${file.type || "unknown"}`);
      }
      const raw = Buffer.from(await file.arrayBuffer());
      if (raw.length === 0) throw new ApiError(400, `Empty file: ${file.name}`);

      let data: Buffer = raw;
      let mimeType = file.type;
      let ext = "pdf";
      if (file.type !== "application/pdf") {
        const compressed = await compressReceiptImage(raw);
        data = compressed.data;
        mimeType = compressed.mimeType;
        ext = "jpg";
      }

      const id = createId();
      const filePath = await saveReceiptFile(userId, `${id}.${ext}`, data);
      const receipt = await prisma.receipt.create({
        data: { id, userId, filePath, mimeType, originalName: file.name, sizeBytes: data.length },
        select: { id: true, originalName: true, mimeType: true, sizeBytes: true, status: true, createdAt: true },
      });
      created.push(receipt);
    }
    return NextResponse.json({ receipts: created }, { status: 201 });
  });
}
