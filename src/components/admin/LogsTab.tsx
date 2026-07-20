"use client";

/**
 * Audit + extraction trail (docs/ADMIN.md): defaults to PROBLEMS (extraction
 * failures) because that's what an admin comes here for; a toggle widens it to
 * all AI calls, and the audit stream filters by action. Read-only.
 */

import { useCallback, useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";

interface AuditRow {
  id: string;
  action: string;
  detail: string;
  createdAt: string;
  reimbursementId: string | null;
  user: string;
}
interface ExtractionRow {
  id: string;
  kind: string;
  model: string;
  status: string;
  errorMessage: string | null;
  durationMs: number;
  createdAt: string;
  user: string;
}

export default function LogsTab() {
  const t = useTranslations("Admin");
  const format = useFormatter();
  // App-time-zone timestamps (next-intl's global timeZone), not the browser's.
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "short", timeStyle: "medium" });
  // Known audit slugs get plain language; anything unrecognized stays raw so
  // new actions never render blank.
  const actionLabel = (a: string) => {
    const key = `action_${a.replace(/-/g, "_")}`;
    const dyn = t as unknown as ((k: string) => string) & { has: (k: string) => boolean };
    return dyn.has(key) ? dyn(key) : a;
  };
  const tx = t as unknown as (k: string) => string;
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [extraction, setExtraction] = useState<ExtractionRow[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [action, setAction] = useState("");
  const [extractionAll, setExtractionAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (action) params.set("action", action);
      if (extractionAll) params.set("extraction", "all");
      const res = await fetch(`/api/admin/logs?${params.toString()}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as {
        actions: string[];
        audit: AuditRow[];
        extraction: ExtractionRow[];
      };
      setActions(data.actions);
      setAudit(data.audit);
      setExtraction(data.extraction);
    } catch {
      setError(t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [action, extractionAll, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5" data-testid="logs-tab">
      {error && <p role="alert" className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-stone-500">
            {extractionAll ? t("aiCallsTitle") : t("aiProblemsTitle")}
          </h2>
          <label className="flex items-center gap-1.5 text-xs text-stone-500">
            <input
              type="checkbox"
              checked={extractionAll}
              onChange={(e) => setExtractionAll(e.target.checked)}
              data-testid="extraction-all"
            />
            {t("showAllCalls")}
          </label>
        </div>
        {extraction.length === 0 ? (
          <p className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-500">
            {extractionAll ? t("noCalls") : t("noProblems")}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {extraction.map((e) => (
              <li key={e.id} className="rounded-lg border border-stone-200 p-2.5 text-sm" data-testid="extraction-row">
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <span className="font-medium">
                    <span
                      className={`mr-2 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        e.status === "error" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-800"
                      }`}
                    >
                      {tx(`kind_${e.kind}`)}
                    </span>
                    <code className="text-xs text-stone-500">{e.model}</code>
                  </span>
                  <span className="text-xs text-stone-400">{when(e.createdAt)}</span>
                </div>
                <div className="mt-0.5 text-xs text-stone-500">
                  {e.user} · {t("durationMs", { ms: e.durationMs })}
                </div>
                {e.errorMessage && <p className="mt-1 break-words text-xs text-red-700">{e.errorMessage}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-stone-500">{t("auditTitle")}</h2>
          <select
            className="input max-w-[14rem] text-sm"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            data-testid="audit-action-filter"
          >
            <option value="">{t("allActions")}</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {actionLabel(a)}
              </option>
            ))}
          </select>
        </div>
        {loading && audit.length === 0 ? (
          <p className="text-sm text-stone-400">{t("loading")}</p>
        ) : audit.length === 0 ? (
          <p className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-500">{t("noEvents")}</p>
        ) : (
          <ul className="space-y-1.5">
            {audit.map((e) => (
              <li key={e.id} className="rounded-lg border border-stone-200 p-2.5 text-sm" data-testid="audit-row">
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <span className="text-xs font-semibold text-stone-700">
                    {actionLabel(e.action)}
                  </span>
                  <span className="text-xs text-stone-400">{when(e.createdAt)}</span>
                </div>
                <div className="mt-0.5 text-xs text-stone-500">{e.user}</div>
                {/* The raw JSON is for whoever debugs — one tap away, never the
                    face of the row (the plain-language rule the rest of admin
                    already follows). */}
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] text-stone-400">{t("detailToggle")}</summary>
                  <p className="mt-1 break-words font-mono text-[11px] text-stone-500">{e.detail}</p>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
