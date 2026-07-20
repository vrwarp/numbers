import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { currentUserId } from "@/auth";
import { prisma } from "@/lib/prisma";
import Shoebox from "@/components/Shoebox";
import ActivityCard from "@/components/notifications/ActivityCard";
import EsignNudgeCard from "@/components/EsignNudgeCard";
import { embeddingEnabled } from "@/lib/embeddings/settings";
import { esignSetupSnapshot } from "@/lib/esign/nudge-server";

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
  const esign = await esignSetupSnapshot(userId).catch(() => null);
  // First-run suppression (P1): while the Shoebox empty-state guide is the
  // page, its predicate-branched step-4 line carries the e-sign message alone
  // — no second pitch on the same screen. Duty/closure cards are exempt (a
  // Position holder may never upload a receipt; closure implies claims exist).
  const receiptCount = await prisma.receipt.count({ where: { userId } });

  // ONE ambient nudge (P1). The duty card OUTRANKS the profile nudge — the
  // highest-stakes signal must not hide behind a mailing-address nag for
  // weeks; every other e-sign card yields to it.
  const homeCard = esign?.homeCard ?? null;
  const dutyCard = homeCard?.variant === "duty" ? homeCard : null;
  const memberOrClosure =
    homeCard && homeCard.variant !== "duty" && !profileIncomplete
      ? homeCard.variant === "member"
        ? receiptCount > 0
          ? homeCard
          : null
        : homeCard
      : null;
  const nudge = dutyCard ?? memberOrClosure;
  const showProfileNudge = profileIncomplete && !dutyCard;

  const t = await getTranslations("Home");

  return (
    <div className="space-y-6">
      {showProfileNudge && (
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
      <Shoebox
        searchEnabled={searchEnabled}
        esignOffered={esign?.eligible ?? false}
        nudgeSlot={nudge ? <EsignNudgeCard decision={nudge} /> : null}
      />
      <ActivityCard />
    </div>
  );
}
