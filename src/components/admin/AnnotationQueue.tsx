"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { Tab } from "./AdminDashboard";

/**
 * Overview card for the background receipt-reading queue — the annotation
 * counterpart of the search tab's embedding-queue health block. Status line
 * first (caught up / backlog with an ETA at the current pace / paused), the
 * four counts, then the receipts the worker gave up on with their raw errors
 * and a retry (per receipt, or all).
 */

type QueueStatus = {
  queue: {
    queued: number;
    running: number;
    failed: number;
    done: number;
    backfillPending: number;
    oldestQueuedAt: string | null;
  };
  receipts: { total: number; annotated: number };
  paceMs: number;
  ready: boolean;
  mock: boolean;
  failedJobs: {
    receiptId: string;
    originalName: string | null;
    ownerEmail: string | null;
    attempts: number;
    lastError: string;
    updatedAt: string;
  }[];
};

function Stat({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className="card p-3" data-testid={testId}>
      <div className="text-xl font-bold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-stone-500">{label}</div>
    </div>
  );
}

export default function AnnotationQueue({ onNavigate }: { onNavigate: (t: Tab) => void }) {
  const t = useTranslations("Admin");
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/extraction-jobs");
    if (res.ok) setStatus((await res.json()) as QueueStatus);
  }, []);

  useEffect(() => {
    void load();
    // The queue moves on its own (one receipt a minute) — keep the card live.
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!status) return null; // the Overview's own loading state covers the gap

  const { queue, receipts } = status;
  const backlog = queue.queued + queue.running;
  const paused = !status.ready && !status.mock;
  const etaMinutes = Math.max(1, Math.ceil((queue.queued * status.paceMs) / 60_000));

  async function retry(receiptIds?: string[]) {
    setBusy(true);
    try {
      await fetch("/api/admin/extraction-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(receiptIds ? { receiptIds } : {}),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2" data-testid="annotation-queue">
      <h2 className="text-sm font-semibold text-stone-500">{t("annotationTitle")}</h2>

      {paused ? (
        <p
          className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
          data-testid="annotation-queue-status"
        >
          <span className="flex-1">{t("annotationNotConfigured")}</span>
          <button className="shrink-0 text-xs font-semibold underline" onClick={() => onNavigate("settings")}>
            {t("fixInSettings")}
          </button>
        </p>
      ) : backlog === 0 ? (
        <p
          className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
          data-testid="annotation-queue-status"
        >
          ✓ {t("annotationAllRead", { annotated: receipts.annotated, total: receipts.total })}
        </p>
      ) : (
        <p
          className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700"
          data-testid="annotation-queue-status"
        >
          {t("annotationBacklog", { queued: backlog, minutes: etaMinutes })}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={t("statAnnotationWaiting")} value={queue.queued} testId="annotation-stat-queued" />
        <Stat label={t("statAnnotationReading")} value={queue.running} testId="annotation-stat-running" />
        <Stat label={t("statAnnotationFailed")} value={queue.failed} testId="annotation-stat-failed" />
        <Stat label={t("statAnnotationRead")} value={receipts.annotated} testId="annotation-stat-read" />
      </div>

      {status.failedJobs.length > 0 && (
        <div className="card divide-y divide-stone-100 p-0">
          <div className="flex items-center justify-between px-3 py-2">
            <h3 className="text-xs font-semibold text-stone-500">{t("annotationFailedTitle")}</h3>
            <button
              className="text-xs font-semibold text-indigo-600 underline underline-offset-2 hover:text-indigo-800 disabled:opacity-50"
              onClick={() => retry()}
              disabled={busy}
              data-testid="annotation-retry-all"
            >
              {t("annotationRetryAll")}
            </button>
          </div>
          {status.failedJobs.map((j) => (
            <div
              key={j.receiptId}
              className="flex items-center gap-3 px-3 py-2 text-sm"
              data-testid={`annotation-failed-${j.receiptId}`}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{j.originalName ?? j.receiptId}</div>
                <div className="truncate text-xs text-stone-500" title={j.lastError}>
                  {j.ownerEmail && <span>{j.ownerEmail} · </span>}
                  {t("annotationAttempts", { count: j.attempts })} · {j.lastError}
                </div>
              </div>
              <button
                className="shrink-0 text-xs font-semibold text-indigo-600 underline underline-offset-2 hover:text-indigo-800 disabled:opacity-50"
                onClick={() => retry([j.receiptId])}
                disabled={busy}
                data-testid={`annotation-retry-${j.receiptId}`}
              >
                {t("annotationRetry")}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
