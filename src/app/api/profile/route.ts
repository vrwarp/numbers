import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId, handleApi, ApiError } from "@/lib/api";
import { setLocaleCookie } from "@/i18n/cookie";
import { LOCALES } from "@/lib/locales";

export const runtime = "nodejs";

const userSelect = {
  id: true,
  email: true,
  fullName: true,
  mailingAddress: true,
  role: true,
  locale: true,
} as const;

export async function GET() {
  return handleApi(async () => {
    const userId = await requireUserId();
    const user = await prisma.user.findUnique({ where: { id: userId }, select: userSelect });
    if (!user) throw new ApiError(404, "User not found");
    return NextResponse.json({ user });
  });
}

const PatchSchema = z
  .object({
    fullName: z.string().max(200),
    mailingAddress: z.string().max(500),
    locale: z.enum(LOCALES),
  })
  .partial();

/** Save the name/address that get stamped onto the PDF form (+ UI language). */
export async function PATCH(req: NextRequest) {
  return handleApi(async () => {
    const userId = await requireUserId();
    const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid profile update");
    const user = await prisma.user.update({
      where: { id: userId },
      data: parsed.data,
      select: userSelect,
    });
    // Keep the runtime cookie in step with the stored preference.
    if (parsed.data.locale) await setLocaleCookie(parsed.data.locale);
    return NextResponse.json({ user });
  });
}
