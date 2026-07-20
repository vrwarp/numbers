"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useAutoRefresh } from "@/lib/use-auto-refresh";
import { formatCents } from "@/lib/money";
import type { HomeNudgeDecision } from "@/lib/esign/nudge-state";

/**
 * The home-slot e-sign nudge system (docs/ESIGN_SETUP_DISCOVERABILITY.md §3.5):
 * ONE card machinery for the member invite, the duty (Position-holder) variant,
 * and the one-shot closure card. Server-decided (the page passes the decision),
 * client-live: a small island re-checks the badges endpoint on the standard
 * 90s cadence so attestation mid-session or the admin kill-switch clears the
 * card without a navigation — deferred while focus is inside it, so the ground
 * never vanishes under a keyboard user.
 *
 * Consent discipline (P2): the labeled decline is TERMINAL and every mark is
 * an explicit client action posted as an intent to the monotonic merge —
 * nothing here marks state during render except the two idempotent decay
 * anchors (firstSeen / paperRepeatShown), which are fire-and-forget.
 */

async function markNudge(patch: Record<string, true>) {
  try {
    await fetch("/api/esign/nudges", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  } catch {
    /* a lost mark re-invites at worst — never block the UI on it */
  }
}

export default function EsignNudgeCard({ decision }: { decision: HomeNudgeDecision }) {
  const t = useTranslations("Home");
  const format = useFormatter();
  const [hidden, setHidden] = useState(false);
  // sr-only live line: announce resolution politely, never the whole card and
  // never the initial render (the card is ordinary page content on load).
  const [announce, setAnnounce] = useState("");
  const cardRef = useRef<HTMLDivElement>(null);
  const wantHide = useRef(false);

  const { variant, state, collapsed, paperRepeat, closureClaim } = decision;

  // Decay anchors: idempotent, fire-and-forget (server keeps the earliest).
  useEffect(() => {
    if (variant === "member" && state === "none" && !collapsed) void markNudge({ firstSeenMember: true });
    if (paperRepeat) void markNudge({ paperRepeatShown: true });
  }, [variant, state, collapsed, paperRepeat]);

  const hideNow = useCallback(
    (message: string) => {
      // Defer removal while focus is inside the card (F8): pulling the DOM out
      // from under a keyboard user strands focus on <body>.
      if (cardRef.current?.contains(document.activeElement)) {
        wantHide.current = true;
        return;
      }
      setHidden(true);
      setAnnounce(message);
    },
    []
  );

  // Live refresh: identity state changed elsewhere (vouched at church while
  // the tab was open) or the admin paused the persuasion layer — clear within
  // one poll instead of waiting for a navigation.
  useAutoRefresh(
    () =>
      void fetch("/api/esign/badges")
        .then((r) => (r.ok ? r.json() : null))
        .then(
          (b?: { enabled?: boolean; identityStatus?: string | null; nudgesEnabled?: boolean } | null) => {
            if (!b) return;
            const stale =
              !b.enabled ||
              b.nudgesEnabled === false ||
              (variant !== "closure" &&
                (b.identityStatus ?? null) !== (state === "pending" ? "pending" : null)) ||
              (variant === "closure" && b.identityStatus !== "attested");
            if (stale) hideNow(t("esignNudgeResolved"));
          }
        )
        .catch(() => {}),
    { intervalMs: 90_000 }
  );

  const onBlurMaybeHide = () => {
    if (wantHide.current && !cardRef.current?.contains(document.activeElement)) {
      setHidden(true);
      setAnnounce(t("esignNudgeResolved"));
    }
  };

  if (hidden) {
    return (
      <p aria-live="polite" className="sr-only" data-testid="esign-nudge-live">
        {announce}
      </p>
    );
  }

  const duty = variant === "duty";
  // Tinted shell carries the signal; body text stays stone so the card never
  // reads as a wall of warning — only the title takes the variant color.
  const cardTone = duty
    ? "border-amber-200 bg-amber-50 text-stone-700"
    : "border-indigo-200 bg-indigo-50 text-stone-700";
  const titleTone = duty ? "text-amber-900" : "text-indigo-950";

  // Collapsed = the decayed/capped one-line door. Still a real link; no chrome.
  if (collapsed) {
    return (
      <Link
        href="/profile?open=esign"
        className={`flex max-w-2xl items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium ${cardTone} ${titleTone}`}
        data-testid={duty ? "esign-nudge-duty-collapsed" : "esign-nudge-collapsed"}
      >
        <span aria-hidden>✍️</span>
        {state === "pending" ? t("esignNudgeCollapsedPending") : t("esignNudgeCollapsed")}
      </Link>
    );
  }

  return (
    <div ref={cardRef} onBlur={onBlurMaybeHide} data-testid="esign-nudge-slot">
      <p aria-live="polite" className="sr-only" data-testid="esign-nudge-live">
        {announce}
      </p>
      {/* Not `.card`: its bg-white would win the cascade over the tint. Capped
          width on wide screens — a full-bleed invitation band reads as a
          takeover, not a suggestion. */}
      <div
        className={`max-w-2xl space-y-3 rounded-xl border p-4 text-sm shadow-sm short:space-y-2 short:p-3 ${cardTone}`}
        data-testid={`esign-nudge-${variant}`}
      >
        {variant === "closure" ? (
          <>
            <p className={`font-semibold ${titleTone}`}>{t("esignClosureTitle")}</p>
            <p>
              {closureClaim
                ? t("esignClosure", {
                    date: format.dateTime(new Date(closureClaim.createdAt), {
                      month: "long",
                      day: "numeric",
                    }),
                    amount: formatCents(closureClaim.totalCents),
                  })
                : t("esignClosureNoClaim")}
            </p>
            <p>
              {t.rich("esignClosureVouchLine", {
                b: (chunks) => <strong className="font-semibold">{chunks}</strong>,
              })}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              {closureClaim && (
                <Link
                  href={`/claims/${closureClaim.id}`}
                  className="btn-primary w-full !px-4 text-center sm:w-auto"
                  onClick={() => void markNudge({ closureShown: true })}
                  data-testid="esign-nudge-closure-cta"
                >
                  {t("esignClosureCta")}
                </Link>
              )}
              <button
                className="btn-secondary w-full !px-4 sm:w-auto"
                onClick={() => {
                  void markNudge({ closureShown: true });
                  setHidden(true);
                  setAnnounce(t("esignNudgeResolved"));
                }}
                data-testid="esign-nudge-closure-gotit"
              >
                {t("esignClosureGotIt")}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className={`font-semibold ${titleTone}`}>
              {duty
                ? state === "pending"
                  ? t("esignDutyPendingTitle")
                  : t("esignDutyTitle")
                : state === "pending"
                  ? t("esignNudgePendingTitle")
                  : paperRepeat
                    ? t("esignNudgePaperRepeatTitle")
                    : t("esignNudgeTitle")}
            </p>
            <p>
              {duty
                ? state === "pending"
                  ? t("esignDutyPending")
                  : t("esignDutyNull")
                : state === "pending"
                  ? t("esignNudgePending")
                  : paperRepeat
                    ? t("esignNudgePaperRepeat")
                    : t("esignNudgeNull")}
            </p>
            {duty && state === "none" && (
              // The one hard warning gets its own quiet paragraph — the body
              // above stays capability-toned.
              <p className="text-amber-900">{t("esignDutyRecovery")}</p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <Link
                href="/profile?open=esign"
                className="btn-primary w-full !px-4 text-center sm:w-auto"
                data-testid="esign-nudge-cta"
              >
                {state === "pending" ? t("esignNudgePendingCta") : t("esignNudgeNullCta")}
              </Link>
              {duty ? (
                <button
                  className="btn-secondary w-full !px-4 sm:w-auto"
                  onClick={() => {
                    void markNudge({ dutySnooze: true });
                    setHidden(true);
                    setAnnounce(t("esignNudgeResolved"));
                  }}
                  data-testid="esign-nudge-snooze"
                >
                  {t("esignDutySnooze")}
                </button>
              ) : state === "none" ? (
                // The decline is labeled and the same button geometry as the
                // CTA — a legitimate choice, not an escape hatch (P6).
                <button
                  className="btn-secondary w-full !px-4 sm:w-auto"
                  onClick={() => {
                    void markNudge({ declined: true });
                    setHidden(true);
                    setAnnounce(t("esignNudgeResolved"));
                  }}
                  data-testid="esign-nudge-decline"
                >
                  {t("esignNudgeDecline")}
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
