"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/use-api-error";
import { formatCents } from "@/lib/money";

/**
 * Admin "Search" tab (docs/SEARCH_DESIGN.md §10) — outcome language for a
 * volunteer admin: status line first ("Search is up to date" / ETA), the
 * literal member-facing note during rebuilds, failed items in mapped outcome
 * language with raw errors in an expando, the probe-driven settings form
 * (detected dim, never typed), and the test-query box — the only place
 * relevance scores are visible.
 */

type Status = {
  configured: boolean;
  settings: {
    enabled: boolean;
    endpoint: string;
    model: string;
    dim: number;
    queryPrefix: string;
    minScore: number;
    apiKeySet: boolean;
    apiKeyFingerprint: string;
  } | null;
  envDiffers: boolean;
  queue: {
    queued: number;
    running: number;
    failed: number;
    indexed: number;
    rebuildPending: number;
    oldestQueuedAt: string | null;
    avgItemMs: number;
  };
  failedJobs: { id: string; kind: string; targetId: string; lastError: string; updatedAt: string }[];
  defaultQueryPrefix: string;
};

type TestItem = {
  kind: string;
  id: string;
  score?: number;
  merchant?: string;
  note?: string;
  claimDescription?: string;
  totalCents?: number;
  ownerName?: string;
  year: number;
};
type TestResult = {
  exact: TestItem[];
  best: TestItem | null;
  groups: { year: number; items: TestItem[] }[];
};

function errorClassKey(lastError: string): "unreadableImage" | "tooLong" | "endpointDown" | "generic" {
  if (/failed to load image/i.test(lastError)) return "unreadableImage";
  if (/exceed_context|context size/i.test(lastError)) return "tooLong";
  if (/fetch|timeout|abort|ECONN|50[23]/i.test(lastError)) return "endpointDown";
  return "generic";
}

export default function SearchIndexTab() {
  const t = useTranslations("Admin.search");
  const errorMessage = useApiErrorMessage();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Settings form state
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [queryPrefix, setQueryPrefix] = useState("");
  const [minScore, setMinScore] = useState("0.25");
  const [enabled, setEnabled] = useState(false);
  const [skipProbe, setSkipProbe] = useState(false);
  const [manualDim, setManualDim] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<string | null>(null);

  const [testQuery, setTestQuery] = useState("");
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/embeddings");
    if (!res.ok) {
      setError(errorMessage(await res.json().catch(() => null), t("loadFailed")));
      return;
    }
    const data = (await res.json()) as Status;
    setStatus(data);
    if (data.settings) {
      setEndpoint(data.settings.endpoint);
      setModel(data.settings.model);
      setQueryPrefix(data.settings.queryPrefix);
      setMinScore(String(data.settings.minScore));
      setEnabled(data.settings.enabled);
    } else {
      setModel("qwen3-vl-embedding-2b");
      setQueryPrefix(data.defaultQueryPrefix);
    }
  }, [errorMessage, t]);

  useEffect(() => {
    void load();
    // Refresh health every 15 s while the tab is open (rebuild progress).
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, [load]);

  const call = useCallback(
    async (label: string, url: string, body?: object) => {
      setBusy(label);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!res.ok) {
          setError(errorMessage(await res.json().catch(() => null), t("actionFailed")));
          return null;
        }
        return await res.json();
      } finally {
        setBusy(null);
      }
    },
    [errorMessage, t]
  );

  const save = useCallback(async () => {
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/embeddings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          endpoint,
          ...(apiKey ? { apiKey } : {}),
          model,
          queryPrefix,
          minScore: Number(minScore) || 0.25,
          ...(skipProbe ? { skipProbe: true, ...(manualDim ? { dim: Number(manualDim) } : {}) } : {}),
        }),
      });
      if (!res.ok) {
        setError(errorMessage(await res.json().catch(() => null), t("actionFailed")));
        return;
      }
      const data = await res.json();
      setApiKey("");
      setNotice(data.rebuildStarted ? t("savedRebuilding") : t("saved"));
      await load();
    } finally {
      setBusy(null);
    }
  }, [enabled, endpoint, apiKey, model, queryPrefix, minScore, skipProbe, manualDim, errorMessage, t, load]);

  const probe = useCallback(async () => {
    setProbeResult(null);
    const data = await call("probe", "/api/admin/embeddings/probe", {
      endpoint,
      ...(apiKey ? { apiKey } : {}),
      model,
    });
    if (data) setProbeResult(t("probeOk", { dim: data.dim, ms: data.ms }));
  }, [call, endpoint, apiKey, model, t]);

  const runTestQuery = useCallback(async () => {
    if (!testQuery.trim()) return;
    const data = await call("test", "/api/admin/embeddings/test-query", { query: testQuery });
    if (data) setTestResult(data as TestResult);
  }, [call, testQuery]);

  if (!status) {
    return <p className="text-sm text-stone-500">{error ?? t("loading")}</p>;
  }

  const q = status.queue;
  const etaMinutes = Math.ceil(((q.queued + q.running) * q.avgItemMs) / 60000);
  const memberNote = q.rebuildPending > 0 ? t("memberPreview", { count: q.rebuildPending }) : null;
  const testItems: (TestItem & { section: string })[] = testResult
    ? [
        ...testResult.exact.map((i) => ({ ...i, section: "exact" })),
        ...(testResult.best ? [{ ...testResult.best, section: "best" }] : []),
        ...testResult.groups.flatMap((g) => g.items.map((i) => ({ ...i, section: String(g.year) }))),
      ]
    : [];

  return (
    <div className="space-y-6">
      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}

      {/* Status first, counts second (§10) */}
      {status.configured && status.settings?.enabled && (
        <div className="card space-y-2 p-4">
          <p className="font-semibold">
            {q.queued + q.running === 0
              ? t("statusUpToDate", { indexed: q.indexed })
              : t("statusIndexing", { count: q.queued + q.running, minutes: etaMinutes })}
          </p>
          {q.rebuildPending > 0 && (
            <div data-testid="embedding-rebuild-progress" className="space-y-1">
              <div className="h-2 overflow-hidden rounded-full bg-stone-200">
                <div
                  className="h-full bg-indigo-500 transition-all"
                  style={{ width: `${Math.max(3, Math.round((q.indexed / Math.max(1, q.indexed + q.rebuildPending)) * 100))}%` }}
                />
              </div>
              <p className="text-xs text-stone-500">{t("rebuildProgress", { done: q.indexed, total: q.indexed + q.rebuildPending })}</p>
            </div>
          )}
          {memberNote && <p className="text-xs italic text-stone-500">{memberNote}</p>}
          {q.oldestQueuedAt && q.queued > 0 && (
            <details className="text-xs text-stone-400">
              <summary className="cursor-pointer">{t("queueDetails")}</summary>
              <p className="mt-1">
                {t("queueDetailLine", { queued: q.queued, running: q.running, failed: q.failed, avgSeconds: Math.round(q.avgItemMs / 1000) })}
              </p>
            </details>
          )}
        </div>
      )}

      {/* Settings — "Connect search" empty state when unconfigured */}
      <div className="card space-y-3 p-4" data-testid="embedding-settings-form">
        <h3 className="font-semibold">{status.configured ? t("settingsTitle") : t("connectTitle")}</h3>
        {!status.configured && <p className="text-sm text-stone-500">{t("connectIntro")}</p>}
        {status.envDiffers && <p className="text-xs text-amber-700">{t("envHint")}</p>}
        <label className="block text-sm">
          {t("endpointLabel")}
          <input className="input mt-1 w-full" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://…" />
        </label>
        <label className="block text-sm">
          {t("apiKeyLabel")}
          <input
            className="input mt-1 w-full"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={status.settings?.apiKeySet ? t("apiKeyKept", { fingerprint: status.settings.apiKeyFingerprint }) : ""}
          />
        </label>
        {status.configured && (
          <>
            <label className="block text-sm">
              {t("modelLabel")}
              <input className="input mt-1 w-full" value={model} onChange={(e) => setModel(e.target.value)} />
              <span className="text-xs text-stone-400">{t("modelWarning")}</span>
            </label>
            <p className="text-sm">
              {t("dimLabel")}{" "}
              <span className="font-mono">{status.settings?.dim ? t("dimDetected", { dim: status.settings.dim }) : t("dimUnknown")}</span>
            </p>
            <label className="block text-sm">
              {t("queryPrefixLabel")}
              <input className="input mt-1 w-full" value={queryPrefix} onChange={(e) => setQueryPrefix(e.target.value)} />
            </label>
            <label className="block text-sm">
              {t("minScoreLabel")}
              <input className="input mt-1 w-28" value={minScore} onChange={(e) => setMinScore(e.target.value)} inputMode="decimal" />
            </label>
          </>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t("enabledLabel")}
        </label>
        <label className="flex items-center gap-2 text-xs text-stone-500">
          <input type="checkbox" checked={skipProbe} onChange={(e) => setSkipProbe(e.target.checked)} data-testid="embedding-skip-probe" />
          {t("skipProbeLabel")}
        </label>
        {skipProbe && (
          <label className="block text-xs text-stone-500">
            {t("manualDimLabel")}
            <input className="input mt-1 w-28" value={manualDim} onChange={(e) => setManualDim(e.target.value)} inputMode="numeric" />
          </label>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-secondary" onClick={() => void probe()} disabled={busy !== null} data-testid="embedding-test-connection">
            {busy === "probe" ? t("probing") : t("testConnection")}
          </button>
          <button className="btn-primary" onClick={() => void save()} disabled={busy !== null} data-testid="embedding-save">
            {busy === "save" ? t("saving") : t("save")}
          </button>
          {probeResult && <span className="text-sm text-emerald-700">{probeResult}</span>}
        </div>
      </div>

      {/* Failed items — outcome language, raw error in an expando (§10) */}
      {status.failedJobs.length > 0 && (
        <div className="card space-y-2 p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">{t("failedTitle", { count: status.failedJobs.length })}</h3>
            <button className="btn-secondary text-xs" onClick={() => void call("retryAll", "/api/admin/embeddings/jobs", { all: true }).then(() => load())}>
              {t("retryAll")}
            </button>
          </div>
          <ul className="space-y-2">
            {status.failedJobs.map((j) => (
              <li key={j.id} className="rounded-lg border border-stone-200 p-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span>{t(`failedClass.${errorClassKey(j.lastError)}`, { kind: t(`kind.${j.kind === "receipt" ? "receipt" : "claim"}`) })}</span>
                  <button
                    className="text-xs text-indigo-600 hover:underline"
                    data-testid={`embedding-retry-job-${j.id}`}
                    onClick={() => void call("retry", "/api/admin/embeddings/jobs", { jobId: j.id }).then(() => load())}
                  >
                    {t("retry")}
                  </button>
                </div>
                <details className="mt-1 text-xs text-stone-400">
                  <summary className="cursor-pointer">{t("rawError")}</summary>
                  <code className="break-all">{j.lastError}</code>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Test query — the only place scores render (§10) */}
      {status.configured && status.settings?.enabled && (
        <div className="card space-y-3 p-4">
          <h3 className="font-semibold">{t("testQueryTitle")}</h3>
          <div className="flex gap-2">
            <input
              className="input flex-1"
              value={testQuery}
              onChange={(e) => setTestQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) void runTestQuery();
              }}
              placeholder={t("testQueryPlaceholder")}
              data-testid="embedding-test-query"
            />
            <button className="btn-secondary" onClick={() => void runTestQuery()} disabled={busy !== null}>
              {busy === "test" ? t("probing") : t("run")}
            </button>
          </div>
          {testResult && (
            <ul className="space-y-1 text-sm">
              {testItems.length === 0 && <li className="text-stone-400">{t("testNoResults")}</li>}
              {testItems.map((i) => (
                <li key={`${i.kind}:${i.id}`} className="flex items-center justify-between gap-2 border-b border-stone-100 py-1">
                  <span className="min-w-0 truncate">
                    <span className="mr-2 rounded bg-stone-100 px-1 text-xs">{i.section}</span>
                    {i.kind === "receipt"
                      ? `${i.merchant || i.id} ${i.note ?? ""}`
                      : `${i.claimDescription || i.id} ${i.totalCents !== undefined ? formatCents(i.totalCents) : ""}`}
                    {i.ownerName ? ` · ${i.ownerName}` : ""}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-stone-500">
                    {i.score !== undefined ? i.score.toFixed(3) : t("scoreExact")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Rebuild */}
      {status.configured && (
        <div className="card flex items-center justify-between gap-3 p-4">
          <div>
            <h3 className="font-semibold">{t("rebuildTitle")}</h3>
            <p className="text-xs text-stone-500">{t("rebuildHint")}</p>
          </div>
          <button
            className="btn-secondary"
            data-testid="embedding-rebuild"
            onClick={() => void call("rebuild", "/api/admin/embeddings/rebuild").then(() => load())}
            disabled={busy !== null}
          >
            {busy === "rebuild" ? t("probing") : t("rebuild")}
          </button>
        </div>
      )}
    </div>
  );
}
