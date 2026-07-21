"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useModalDismiss } from "@/lib/use-modal-dismiss";
import {
  buildDiagnostics,
  installCapture,
  recordNav,
  takeStashedCrash,
} from "@/lib/feedback/capture";
import { isSensitiveRoute, routeTemplate } from "@/lib/feedback/sensitive";
import { enqueue, flush } from "@/lib/feedback/outbox";
import { FEEDBACK_EVENT, type OpenFeedbackDetail } from "@/lib/feedback/open";
import type { CrashInfo, FeedbackCategory, FeedbackPayload } from "@/lib/feedback/types";

/**
 * App-wide feedback runtime (docs/FEEDBACK_DESIGN.md), mounted like
 * NotificationsRuntime. It:
 *  - installs passive capture (breadcrumbs, request-id, error hooks) once,
 *  - flushes the offline outbox on load / reconnect,
 *  - records navigation breadcrumbs,
 *  - opens the report sheet on the `numbers:feedback` event (account menu /
 *    contextual triggers) and auto-opens after a crash-reload with the stashed
 *    crash attached.
 * The V5 sheet: one-tap category chips up front, note/diagnostics behind
 * progressive disclosure, a plain trust line, and a closed-loop confirmation.
 */

const CATEGORIES: { key: FeedbackCategory; emoji: string }[] = [
  { key: "bug", emoji: "🐞" },
  { key: "confused", emoji: "😕" },
  { key: "idea", emoji: "💡" },
];

function postFeedback(payload: FeedbackPayload): Promise<Response> {
  return fetch("/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const trySend = (p: FeedbackPayload) =>
  postFeedback(p)
    .then((r) => r.ok)
    .catch(() => false);

export default function FeedbackRuntime({ buildSha }: { buildSha: string }) {
  const t = useTranslations("Feedback");
  const locale = useLocale();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [message, setMessage] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [includeDiag, setIncludeDiag] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ ref: string; queued: boolean } | null>(null);
  const [crash, setCrash] = useState<CrashInfo | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const resetForm = useCallback(() => {
    setMessage("");
    setShowNote(false);
    setIncludeDiag(true);
    setError(null);
    setDone(null);
    setCrash(null);
    setCategory("bug");
  }, []);

  // Install capture, flush outbox, and recover a crash-reload — once.
  useEffect(() => {
    installCapture();
    void flush(trySend);
    const onOnline = () => void flush(trySend);
    window.addEventListener("online", onOnline);
    const stashed = takeStashedCrash();
    if (stashed) {
      resetForm();
      setCrash(stashed);
      setCategory("crash");
      setOpen(true);
    }
    return () => window.removeEventListener("online", onOnline);
  }, [resetForm]);

  // Navigation breadcrumb.
  useEffect(() => {
    recordNav(pathname || "/");
  }, [pathname]);

  // Open on the app-wide event.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<OpenFeedbackDetail>).detail || {};
      resetForm();
      // The error boundary stashes the crash then dispatches this event.
      const stashed = takeStashedCrash();
      if (stashed) {
        setCrash(stashed);
        setCategory("crash");
      } else if (detail.category) {
        setCategory(detail.category as FeedbackCategory);
      }
      setOpen(true);
    };
    window.addEventListener(FEEDBACK_EVENT, handler);
    return () => window.removeEventListener(FEEDBACK_EVENT, handler);
  }, [resetForm]);

  const close = useCallback(() => {
    if (busy) return;
    setOpen(false);
  }, [busy]);

  useModalDismiss(dialogRef, close, open);

  const sensitive = isSensitiveRoute(pathname || "/");

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    const diagnostics = includeDiag ? buildDiagnostics(pathname || "/", crash) : null;
    const payload: FeedbackPayload = {
      category,
      message: message.trim(),
      route: routeTemplate(pathname || "/"),
      buildSha,
      locale,
      diagnostics,
    };
    try {
      const res = await postFeedback(payload);
      if (res.status === 429) {
        setError(t("rateLimited"));
        setBusy(false);
        return;
      }
      if (!res.ok) throw new Error("send failed");
      const data = (await res.json()) as { ref?: string };
      setDone({ ref: data.ref || "----", queued: false });
    } catch {
      // Offline / server down: queue it and still confirm to the user — a lost
      // report is worse than a delayed one.
      enqueue(payload);
      setDone({ ref: "----", queued: true });
    } finally {
      setBusy(false);
    }
  }, [category, message, pathname, buildSha, locale, includeDiag, crash, t]);

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t("title")}
      data-testid="feedback-sheet"
    >
      <div className="max-h-[92dvh] w-full max-w-md space-y-4 overflow-y-auto overscroll-contain rounded-t-2xl bg-white p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] short:space-y-3 short:p-4 sm:rounded-2xl sm:pb-6">
        {done ? (
          <div className="text-center" data-testid="feedback-done">
            <div
              className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-2xl text-emerald-600 ring-4 ring-emerald-500/10"
              aria-hidden
            >
              ✓
            </div>
            <h3 className="text-lg font-bold">{t("thanksTitle")}</h3>
            <p className="mx-auto mt-1.5 max-w-[30ch] text-sm text-stone-500">
              {done.queued ? t("queuedBody") : t("thanksBody")}
            </p>
            {!done.queued && (
              <div className="mt-3.5 inline-flex items-center gap-2 rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5">
                <span className="font-mono text-sm font-bold text-stone-700">
                  {t("reference", { ref: done.ref })}
                </span>
                <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
                  {t("statusNew")}
                </span>
              </div>
            )}
            <button type="button" className="btn-secondary mt-5 w-full py-3" onClick={close}>
              {t("done")}
            </button>
          </div>
        ) : (
          <>
            <div>
              <h3 className="text-base font-bold tracking-tight">{t("title")}</h3>
              <p className="mt-0.5 text-xs text-stone-500">
                {crash ? t("crashSubtitle") : t("subtitle")}
              </p>
            </div>

            <div className="flex flex-col gap-2" role="radiogroup" aria-label={t("title")}>
              {(crash ? [...CATEGORIES, { key: "crash" as const, emoji: "💥" }] : CATEGORIES).map(
                ({ key, emoji }) => {
                  const selected = category === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setCategory(key)}
                      data-testid={`feedback-cat-${key}`}
                      className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left text-[15px] font-semibold transition ${
                        selected
                          ? "border-indigo-600 bg-indigo-50 text-indigo-800 ring-1 ring-inset ring-indigo-600"
                          : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
                      }`}
                    >
                      <span aria-hidden className="text-lg">
                        {emoji}
                      </span>
                      {t(`category.${key}`)}
                    </button>
                  );
                }
              )}
            </div>

            {/* Progressive disclosure: the deacon never has to type; the power
                reporter opens a note. */}
            {showNote ? (
              <textarea
                className="input min-h-[84px] resize-none"
                placeholder={t("notePlaceholder")}
                value={message}
                maxLength={2000}
                onChange={(e) => setMessage(e.target.value)}
                data-testid="feedback-note"
                autoFocus
              />
            ) : (
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-lg border border-stone-200 px-3 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-50"
                onClick={() => setShowNote(true)}
                data-testid="feedback-add-note"
              >
                <span>＋ {t("addNote")}</span>
                <span aria-hidden className="text-stone-400">
                  ▸
                </span>
              </button>
            )}

            {/* Diagnostics consent — plain language, community-framed. */}
            <div className="rounded-lg bg-stone-50 px-3 py-2.5 text-[13px] text-stone-600">
              <label className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={includeDiag}
                  onChange={(e) => setIncludeDiag(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0"
                  data-testid="feedback-include-diagnostics"
                />
                <span>
                  <span className="font-semibold text-stone-700">{t("includeDiagnostics")}</span>
                  <span className="mt-0.5 block leading-snug text-stone-500">
                    {t("diagnosticsNote")}
                    {sensitive ? ` ${t("sensitiveNote")}` : ""}
                  </span>
                </span>
              </label>
            </div>

            {error && (
              <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">
                {error}
              </p>
            )}

            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1 py-3" onClick={close} disabled={busy}>
                {t("cancel")}
              </button>
              <button
                type="button"
                className="btn-primary flex-[2] py-3 text-base"
                onClick={() => void submit()}
                disabled={busy}
                data-testid="feedback-send"
              >
                {busy ? "…" : t("send")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
