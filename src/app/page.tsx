import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { currentUserId } from "@/auth";
import { prisma } from "@/lib/prisma";
import Shoebox from "@/components/Shoebox";
import ActivityCard from "@/components/notifications/ActivityCard";
import { embeddingEnabled } from "@/lib/embeddings/settings";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { fullName: true, mailingAddress: true },
  });
  const profileIncomplete = !user?.fullName || !user?.mailingAddress;
  const searchEnabled = await embeddingEnabled().catch(() => false);
  const t = await getTranslations("Home");

  return (
    <div className="space-y-6">
      {profileIncomplete && (
        <>
          {/* Full sentence at normal heights; a one-line tappable chip when the
              viewport is short, so it costs one line instead of three. */}
          <div
            className="card border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 short:hidden"
            data-testid="profile-nudge"
          >
            {t.rich("profileNudge", {
              link: (chunks) => (
                <Link href="/profile" className="font-semibold underline">
                  {chunks}
                </Link>
              ),
            })}
          </div>
          <Link
            href="/profile"
            className="hidden items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 short:flex"
            data-testid="profile-nudge-short"
          >
            <span aria-hidden>⚠</span> {t("profileNudgeShort")}
          </Link>
        </>
      )}
      <Shoebox searchEnabled={searchEnabled} />
      <ActivityCard />
    </div>
  );
}
