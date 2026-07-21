"use client";

import { useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { shortRef } from "@/lib/feedback/types";

/**
 * "Your reports" — the reporter's own feedback with its triage status
 * (docs/FEEDBACK_DESIGN.md §8). The visible half of the closed loop: a volunteer
 * who can see "Looking into it → Seen → Done" learns that reporting is worth it,
 * which is what earns the next report. Owner-scoped (GET /api/feedback); renders
 * nothing until it knows there's at least one report, so it never adds an empty
 * card to a first-time user's profile.
 */

interface Report {
  id: string;
  category: string;
  message: string;
  status: string;
  createdAt: string;
}

const CATEGORY_EMOJI: Record<string, string> = {
  bug: "🐞",
  confused: "😕",
  idea: "💡",
  crash: "💥",
};

export default function FeedbackHistoryCard() {
  const t = useTranslations("Feedback");
  const format = useFormatter();
  const [reports, setReports] = useState<Report[] | null>(null);

  useEffect(() => {
    let alive = true;
    void fetch("/api/feedback")
      .then((r) => (r.ok ? r.json() : { reports: [] }))
      .then((data: { reports?: Report[] }) => {
        if (alive) setReports(data.reports ?? []);
      })
      .catch(() => {
        if (alive) setReports([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Don't render an empty card — nothing to show a first-time user.
  if (!reports || reports.length === 0) return null;

  const catLabel = (c: string) => {
    const dyn = t as unknown as ((k: string) => string) & { has: (k: string) => boolean };
    const key = `category.${c}`;
    return dyn.has(key) ? dyn(key) : c;
  };
  const statusLabel = (s: string) =>
    s === "triaged" ? t("statusTriaged") : s === "closed" ? t("statusClosed") : t("statusNew");
  const statusClass = (s: string) =>
    s === "closed"
      ? "bg-emerald-50 text-emerald-700"
      : s === "triaged"
        ? "bg-amber-50 text-amber-700"
        : "bg-indigo-50 text-indigo-700";

  return (
    <div className="card p-5" data-testid="feedback-history">
      <h2 className="text-base font-bold">{t("yourReports")}</h2>
      <ul className="mt-3 space-y-2">
        {reports.map((r) => (
          <li key={r.id} className="rounded-xl border border-stone-200 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-stone-800">
                <span aria-hidden>{CATEGORY_EMOJI[r.category] ?? "•"}</span>
                <span className="truncate">{catLabel(r.category)}</span>
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusClass(r.status)}`}
              >
                {statusLabel(r.status)}
              </span>
            </div>
            {r.message && (
              <p className="mt-1 line-clamp-2 break-words text-sm text-stone-600">{r.message}</p>
            )}
            <p className="mt-1 flex items-center gap-2 text-[11px] text-stone-400">
              <code className="font-mono">#{shortRef(r.id)}</code>
              <span aria-hidden>·</span>
              {format.dateTime(new Date(r.createdAt), { dateStyle: "medium" })}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
