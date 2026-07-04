import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { readStoredFile } from "@/lib/storage";

export const runtime = "nodejs";

/** Serve the stored receipt file (auth: owner only). `?original=1` serves the
 *  pristine upload from its sidecar (for the editor's staged reset preview),
 *  falling back to the current file when no original was preserved. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const receipt = await prisma.receipt.findFirst({ where: { id, userId } });
    if (!receipt) throw new ApiError(404, "Receipt not found");
    const wantOriginal = new URL(req.url).searchParams.get("original") === "1";
    const relPath =
      wantOriginal && receipt.originalFilePath ? receipt.originalFilePath : receipt.filePath;
    const data = await readStoredFile(relPath);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": receipt.mimeType,
        "Content-Disposition": `inline; filename="${receipt.originalName.replace(/"/g, "")}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  });
}
