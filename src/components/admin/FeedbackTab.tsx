"use client";

/**
 * Admin feedback triage (docs/FEEDBACK_DESIGN.md §4). A queue a non-engineer can
 * read: the reporter's own words and situation up front, the redacted
 * diagnostics one tap away, and new → triaged → closed transitions. Read grant
 * is admin-only (the route enforces it); this is the human end of the closed
 * loop.
 */

import { useCallback, useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { shortRef } from "@/lib/feedback/types";
import { reportToMarkdown } from "@/lib/feedback/report-markdown";

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fallback for insecure contexts / older browsers.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(ta);
    }
  }
}

interface Report {
  id: string;
  category: string;
  situation: string;
  message: string;
  route: string;
  buildSha: string;
  locale: string;
  userAgent: string;
  status: string;
  createdAt: string;
  reporter: string;
  diagnostics: unknown;
}

const STATUS_FILTERS = ["", "new", "triaged", "closed"] as const;

const CATEGORY_EMOJI: Record<string, string> = {
  bug: "🐞",
  confused: "😕",
  idea: "💡",
  crash: "💥",
};

export default function FeedbackTab() {
  const t = useTranslations("Admin");
  const tf = useTranslations("Feedback");
  const format = useFormatter();
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "short", timeStyle: "short" });

  const [reports, setReports] = useState<Report[]>([]);
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = filter ? `?status=${filter}` : "";
      const res = await fetch(`/api/admin/feedback${params}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { reports: Report[] };
      setReports(data.reports);
    } catch {
      setError(t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [filter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const setStatus = useCallback(
    async (id: string, status: string) => {
      // Optimistic; reload on failure.
      setReports((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)));
      try {
        const res = await fetch("/api/admin/feedback", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, status }),
        });
        if (!res.ok) throw new Error();
      } catch {
        void load();
      }
    },
    [load]
  );

  const catLabel = (c: string) => {
    const dyn = tf as unknown as ((k: string) => string) & { has: (k: string) => boolean };
    const key = `category.${c}`;
    return dyn.has(key) ? dyn(key) : c;
  };
  const statusLabel = (s: string) => {
    const dyn = t as unknown as ((k: string) => string) & { has: (k: string) => boolean };
    const key = `feedbackStatus_${s}`;
    return dyn.has(key) ? dyn(key) : s;
  };

  const copy = async (r: Report) => {
    const md = reportToMarkdown(r, {
      category: catLabel(r.category),
      status: statusLabel(r.status),
      when: when(r.createdAt),
    });
    await copyText(md);
    setCopiedId(r.id);
    setTimeout(() => setCopiedId((cur) => (cur === r.id ? null : cur)), 1600);
  };

  return (
    <div className="space-y-4" data-testid="feedback-tab">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-stone-500">{t("feedbackTitle")}</h2>
        <div className="flex gap-1">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s || "all"}
              onClick={() => setFilter(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                filter === s
                  ? "bg-indigo-600 text-white"
                  : "border border-stone-300 bg-white text-stone-600 hover:bg-stone-50"
              }`}
            >
              {s ? statusLabel(s) : t("feedbackAllStatuses")}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {loading && reports.length === 0 ? (
        <p className="text-sm text-stone-400">{t("loading")}</p>
      ) : reports.length === 0 ? (
        <p className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-500">
          {t("feedbackEmpty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {reports.map((r) => (
            <li key={r.id} className="rounded-lg border border-stone-200 p-3 text-sm" data-testid="feedback-row">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="flex items-center gap-2 font-medium text-stone-800">
                  <span aria-hidden className="text-base">
                    {CATEGORY_EMOJI[r.category] ?? "•"}
                  </span>
                  {catLabel(r.category)}
                  <code className="font-mono text-[11px] text-stone-400">#{shortRef(r.id)}</code>
                </span>
                <span className="text-xs text-stone-400">{when(r.createdAt)}</span>
              </div>

              {r.message ? (
                <p className="mt-1.5 whitespace-pre-wrap break-words text-stone-700">{r.message}</p>
              ) : (
                <p className="mt-1.5 text-stone-400">{t("feedbackNoMessage")}</p>
              )}

              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-stone-500">
                <span>{t("feedbackReportedBy", { name: r.reporter })}</span>
                {r.route ? <code className="font-mono text-stone-500">{r.route}</code> : null}
                {r.buildSha ? <code className="font-mono text-stone-400">{r.buildSha.slice(0, 8)}</code> : null}
                <span className="uppercase text-stone-400">{r.locale}</span>
              </div>

              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-stone-400">
                  {t("feedbackDiagnostics")}
                </summary>
                <pre className="mt-1 max-h-64 overflow-auto rounded bg-stone-50 p-2 font-mono text-[11px] leading-snug text-stone-600">
                  {JSON.stringify(r.diagnostics, null, 2)}
                </pre>
              </details>

              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  onClick={() => void copy(r)}
                  className="rounded-lg border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
                  data-testid="feedback-copy"
                >
                  {copiedId === r.id ? `✓ ${t("feedbackCopied")}` : t("feedbackCopy")}
                </button>
                {r.status !== "triaged" && (
                  <button
                    onClick={() => void setStatus(r.id, "triaged")}
                    className="rounded-lg border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
                  >
                    {t("feedbackMarkTriaged")}
                  </button>
                )}
                {r.status !== "closed" ? (
                  <button
                    onClick={() => void setStatus(r.id, "closed")}
                    className="rounded-lg border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
                  >
                    {t("feedbackMarkClosed")}
                  </button>
                ) : (
                  <button
                    onClick={() => void setStatus(r.id, "new")}
                    className="rounded-lg border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
                  >
                    {t("feedbackReopen")}
                  </button>
                )}
                <span
                  className={`ml-auto self-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    r.status === "new"
                      ? "bg-indigo-50 text-indigo-700"
                      : r.status === "triaged"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-stone-100 text-stone-500"
                  }`}
                >
                  {statusLabel(r.status)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
