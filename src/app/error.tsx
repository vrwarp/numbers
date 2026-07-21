"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { stashCrash } from "@/lib/feedback/capture";
import { openFeedback } from "@/lib/feedback/open";

/**
 * The app's error boundary (docs/FEEDBACK_DESIGN.md) — the first one in numbers.
 * A React render/runtime error would otherwise white-screen with no recovery and
 * no report. Here the user gets a calm recovery screen plus a one-tap "report
 * what happened" that hands the crash to the app-wide FeedbackRuntime (mounted
 * in the layout, which survives this boundary). We stash the crash so the
 * diagnostics bundle can attach it even though a React error never reaches
 * window.onerror. A screenshot is NEVER auto-attached — the crashed screen could
 * be a sensitive one.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("Feedback");

  useEffect(() => {
    stashCrash({ message: error.message || "Render error", stack: error.stack || "" });
  }, [error]);

  return (
    <div className="mx-auto mt-10 max-w-md">
      <div className="card p-6 text-center">
        <div
          className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-50 text-2xl text-red-600"
          aria-hidden
        >
          ⚠️
        </div>
        <h1 className="text-lg font-bold">{t("error.title")}</h1>
        <p className="mx-auto mt-1.5 max-w-[32ch] text-sm text-stone-500">{t("error.body")}</p>
        <div className="mt-5 flex flex-col gap-2">
          <button type="button" className="btn-primary py-3" onClick={() => reset()}>
            {t("error.tryAgain")}
          </button>
          <button
            type="button"
            className="btn-secondary py-3"
            onClick={() => openFeedback({ category: "crash" })}
            data-testid="crash-report"
          >
            {t("error.report")}
          </button>
        </div>
      </div>
    </div>
  );
}
