"use client";

/**
 * Admin landing (docs/ADMIN.md): the "problems" panel + headline numbers. The
 * detailed charts live in Usage; this is the at-a-glance card an admin sees on
 * every visit.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { formatCents } from "@/lib/money";
import type { HealthItem, UsageStats } from "@/lib/admin/overview";
import type { Tab } from "./AdminDashboard";

const LEVEL_STYLES: Record<string, string> = {
  error: "bg-red-50 text-red-800 border-red-200",
  warn: "bg-amber-50 text-amber-900 border-amber-200",
  info: "bg-stone-50 text-stone-600 border-stone-200",
};
const LEVEL_ICON: Record<string, string> = { error: "✗", warn: "!", info: "i" };

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card p-3">
      <div className="text-xl font-bold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-stone-500">{label}</div>
    </div>
  );
}

export default function OverviewTab({ onNavigate }: { onNavigate: (t: Tab) => void }) {
  const t = useTranslations("Admin");
  const tx = t as unknown as (k: string, v?: Record<string, string | number>) => string;
  const [health, setHealth] = useState<HealthItem[] | null>(null);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/admin/overview");
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { health: HealthItem[]; stats: UsageStats };
        setHealth(data.health);
        setStats(data.stats);
      } catch {
        setError(t("loadFailed"));
      }
    })();
  }, [t]);

  if (error) return <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>;
  if (!health || !stats) return <p className="text-sm text-stone-400">{t("loading")}</p>;

  const totalClaims = Object.values(stats.claimsByStatus).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-5">
      <section className="space-y-2" data-testid="health-panel">
        <h2 className="text-sm font-semibold text-stone-500">{t("problemsTitle")}</h2>
        {health.length === 0 ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800" data-testid="health-clear">
            ✓ {t("allClear")}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {health.map((h, i) => (
              <li
                key={i}
                className={`flex items-start gap-2 rounded-lg border p-2.5 text-sm ${LEVEL_STYLES[h.level]}`}
                data-testid={`health-${h.code}`}
              >
                <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-white/60 text-[10px] font-bold">
                  {LEVEL_ICON[h.level]}
                </span>
                <span className="flex-1">{tx(`health_${h.code}`, h.params ?? {})}</span>
                {(h.code === "aiNoKey" || h.code === "firebaseIncomplete" || h.code === "publicUrlUnset") && (
                  <button className="shrink-0 text-xs font-semibold underline" onClick={() => onNavigate("settings")}>
                    {t("fixInSettings")}
                  </button>
                )}
                {h.code === "contextMissing" && (
                  <button className="shrink-0 text-xs font-semibold underline" onClick={() => onNavigate("context")}>
                    {t("editContext")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-stone-500">{t("headlineTitle")}</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label={t("statUsers")} value={stats.users} />
          <Stat label={t("statReceipts")} value={stats.receipts} />
          <Stat label={t("statClaims")} value={totalClaims} />
          <Stat label={t("statSettled")} value={formatCents(stats.settledCents)} />
          <Stat label={t("statAi30")} value={stats.ai.total} />
        </div>
        <p className="text-xs text-stone-400">{t("moreInUsage")}</p>
      </section>
    </div>
  );
}
