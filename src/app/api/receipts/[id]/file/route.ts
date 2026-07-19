import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { readStoredFile } from "@/lib/storage";
import { hasRoleReadGrant } from "@/lib/roles";
import { canReadReceiptViaTeam } from "@/lib/teams-catalog";
import { contentDisposition } from "@/lib/http";

export const runtime = "nodejs";

/** Serve the stored receipt file. Auth: owner, or a verified
 *  approver/treasurer/admin role — the ratified role-read grant
 *  (docs/SEARCH_DESIGN.md §6.3) — or the team read grant (§6.3 team
 *  amendment): a member clicking a team-scope search result must see the
 *  image. Everyone else gets the standard 404. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    let receipt = await prisma.receipt.findFirst({ where: { id, userId } });
    if (
      !receipt &&
      ((await hasRoleReadGrant(userId)) || (await canReadReceiptViaTeam(userId, id)))
    ) {
      receipt = await prisma.receipt.findUnique({ where: { id } });
    }
    if (!receipt) throw new ApiError(404, "Receipt not found", "receiptNotFound");
    const wantOriginal = new URL(req.url).searchParams.get("original") === "1";
    const relPath =
      wantOriginal && receipt.originalFilePath ? receipt.originalFilePath : receipt.filePath;
    const data = await readStoredFile(relPath);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": receipt.mimeType,
        "Content-Disposition": contentDisposition(receipt.originalName),
        "Cache-Control": "private, max-age=3600",
      },
    });
  });
}
