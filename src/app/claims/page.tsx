import Link from "next/link";
import { redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { currentUserId } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/money";
import { relativeDateLabel } from "@/lib/date-label";
import { embeddingEnabled } from "@/lib/embeddings/settings";

export const dynamic = "force-dynamic";

// Full e-sign workflow chip set (docs/ESIGN_DESIGN.md §6.1). Labels live in
// Common.status; draft shows as "needs review" in this list.
const STATUS_STYLES: Record<string, string> = {
  draft: "bg-amber-100 text-amber-800",
  generated: "bg-emerald-100 text-emerald-800",
  submitted: "bg-sky-100 text-sky-800",
  rejected: "bg-red-100 text-red-800",
  approved: "bg-emerald-100 text-emerald-800",
  paid: "bg-indigo-100 text-indigo-800",
};
const STATUS_KEYS = ["generated", "submitted", "rejected", "approved", "paid"] as const;

export default async function ClaimsPage() {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  const claims = await prisma.reimbursement.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { lineItems: true, receipts: true } } },
  });
  const searchEnabled = await embeddingEnabled().catch(() => false);
  const t = await getTranslations("Claims");
  const tStatus = await getTranslations("Common.status");
  const tDate = await getTranslations("Common.date");
  const format = await getFormatter();
  const now = new Date();
  const dateLabels = { today: tDate("today"), yesterday: tDate("yesterday") };

  return (
    <div className="space-y-6 short:space-y-3">
      <div>
        <h1 className="keyboard-smooth text-2xl font-bold short:text-lg">{t("title")}</h1>
        <p className="text-sm text-stone-500 short:hidden">{t("subtitle")}</p>
      </div>

      {searchEnabled && (
        <Link
          href="/search?type=claim"
          data-testid="claims-search-pill"
          className="card pressable flex items-center gap-2 px-4 py-2.5 text-sm text-stone-500"
        >
          <span aria-hidden>🔍</span> {t("searchPill")}
        </Link>
      )}

      {claims.length === 0 ? (
        <div className="card p-10 text-center text-stone-500">
          <div className="text-4xl">🧾</div>
          <p className="mt-2 font-medium">{t("emptyTitle")}</p>
          <p className="text-sm">
            {t.rich("emptyBody", {
              link: (chunks) => (
                <Link href="/" className="text-indigo-600 underline">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {claims.map((c) => (
            <li key={c.id}>
              <Link href={`/claims/${c.id}`} className="card card-lift pressable flex items-center justify-between p-4 short:py-2.5" data-testid={`claim-${c.id}`}>
                <div>
                  <div className="font-semibold">
                    {relativeDateLabel(new Date(c.createdAt), now, dateLabels, (d) =>
                      format.dateTime(d, { year: "numeric", month: "long", day: "numeric" })
                    )}
                  </div>
                  <div className="text-sm text-stone-500">
                    {t("counts", { items: c._count.lineItems, receipts: c._count.receipts })}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-lg font-bold">{formatCents(c.totalCents)}</span>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLES[c.status] ?? STATUS_STYLES.generated}`}
                  >
                    {c.status === "draft"
                      ? tStatus("needsReview")
                      : tStatus(
                          STATUS_KEYS.find((k) => k === c.status) ?? "generated"
                        )}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
