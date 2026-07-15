"use client";

/**
 * Usage stats (docs/ADMIN.md): honest counts, a 30-day AI-call chart, and the
 * only money shown anywhere in admin — the REAL totalCents of settled/paid
 * claims (never an invented per-model spend). Reuses /api/admin/overview.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { formatCents } from "@/lib/money";
import type { UsageStats } from "@/lib/admin/overview";

const CLAIM_STATUSES = ["draft", "generated", "submitted", "approved", "paid", "rejected"] as const;

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="card p-3">
      <div className="text-xl font-bold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-stone-500">{label}</div>
      {sub && <div className="text-[11px] text-stone-400">{sub}</div>}
    </div>
  );
}

export default function UsageTab() {
  const t = useTranslations("Admin");
  const tx = t as unknown as (k: string) => string;
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/admin/overview");
        if (!res.ok) throw new Error();
        setStats(((await res.json()) as { stats: UsageStats }).stats);
      } catch {
        setError(t("loadFailed"));
      }
    })();
  }, [t]);

  if (error) return <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>;
  if (!stats) return <p className="text-sm text-stone-400">{t("loading")}</p>;

  const maxDay = Math.max(1, ...stats.ai.daily.map((d) => d.success + d.error));

  return (
    <div className="space-y-5" data-testid="usage-tab">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-stone-500">{t("totalsTitle")}</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={t("statUsers")} value={stats.users} sub={t("enrolledSub", { n: stats.enrolledMembers })} />
          <Stat label={t("statReceipts")} value={stats.receipts} sub={t("last30Sub", { n: stats.last30.receipts })} />
          <Stat
            label={t("statClaims")}
            value={Object.values(stats.claimsByStatus).reduce((a, b) => a + b, 0)}
            sub={t("last30Sub", { n: stats.last30.claims })}
          />
          <Stat label={t("statSettled")} value={formatCents(stats.settledCents)} sub={t("paidSub", { amount: formatCents(stats.paidCents) })} />
        </div>
      </section>

      <section className="card space-y-2 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-stone-500">{t("claimsByStatus")}</h2>
        </div>
        <ul className="space-y-1">
          {CLAIM_STATUSES.filter((s) => stats.claimsByStatus[s]).map((s) => (
            <li key={s} className="flex items-center justify-between text-sm">
              <span className="text-stone-600">{tx(`status_${s}`)}</span>
              <span className="font-semibold tabular-nums">{stats.claimsByStatus[s]}</span>
            </li>
          ))}
          {Object.keys(stats.claimsByStatus).length === 0 && (
            <li className="text-sm text-stone-400">{t("noneYet")}</li>
          )}
        </ul>
      </section>

      <section className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-stone-500">{t("aiTitle")}</h2>
          <span className="text-xs text-stone-400">
            {t("providerLine", { provider: stats.provider.name, model: stats.provider.model })}
          </span>
        </div>
        <div className="flex gap-4 text-sm">
          <span className="text-emerald-700">{t("aiSuccess", { n: stats.ai.success })}</span>
          <span className="text-red-700">{t("aiError", { n: stats.ai.error })}</span>
        </div>
        {/* 30-day success/error volume. App convention: emerald = ok, red = fail.
            Columns stretch to the row height so the percentage-height bars have a
            definite parent to resolve against. */}
        <div className="flex h-24 items-stretch gap-[3px]" data-testid="ai-chart" role="img" aria-label={t("aiChartAria")}>
          {stats.ai.daily.map((d) => {
            const total = d.success + d.error;
            const h = Math.max((total / maxDay) * 100, 6);
            const errFrac = total ? d.error / total : 0;
            return (
              <div
                key={d.date}
                className="flex flex-1 flex-col justify-end"
                title={t("dayTip", { date: d.date, success: d.success, error: d.error })}
              >
                {total === 0 ? (
                  <div className="w-full rounded-sm bg-stone-200/70" style={{ height: "3%" }} />
                ) : (
                  <div className="w-full overflow-hidden rounded-sm" style={{ height: `${h}%` }}>
                    <div className="w-full bg-red-400" style={{ height: `${errFrac * 100}%` }} />
                    <div className="w-full bg-emerald-400" style={{ height: `${(1 - errFrac) * 100}%` }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex justify-between text-[11px] text-stone-400">
          <span>{t("daysAgo", { n: 30 })}</span>
          <span>{t("today")}</span>
        </div>
      </section>
    </div>
  );
}
