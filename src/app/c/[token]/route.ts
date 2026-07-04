import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleApi, ApiError } from "@/lib/api";
import { readStoredFile, generatedPdfPath } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * Capability URL behind the QR stamp on generated PDFs: serves a claim's
 * latest generated packet to whoever holds the link (e.g. the treasurer
 * scanning a printed form) with NO sign-in.
 *
 * This is the one deliberate exception to the "every route starts with
 * requireUserId()" rule: the 32-char random `publicToken` — minted at PDF
 * generation, never derived from the claim id — is itself the credential.
 * Anything short of an exact token match is a plain 404, indistinguishable
 * from a URL that never existed.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handleApi(async () => {
    const { token } = await ctx.params;
    // Cheap shape check before touching the db (also keeps junk out of logs).
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new ApiError(404, "Not found");

    const reimbursement = await prisma.reimbursement.findUnique({
      where: { publicToken: token },
      select: { id: true, userId: true },
    });
    if (!reimbursement) throw new ApiError(404, "Not found");

    let pdf: Buffer;
    try {
      pdf = await readStoredFile(generatedPdfPath(reimbursement.userId, reimbursement.id));
    } catch {
      // Token exists but the packet file is gone (e.g. volume restored from
      // an older backup) — same 404 as an unknown token.
      throw new ApiError(404, "Not found");
    }

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        // Shown in the browser, not downloaded — the scanner just wants to look.
        "Content-Disposition": `inline; filename="cfcc-reimbursement-${reimbursement.id}.pdf"`,
        // The packet is overwritten on re-generation; never serve a stale copy.
        "Cache-Control": "no-store",
      },
    });
  });
}
