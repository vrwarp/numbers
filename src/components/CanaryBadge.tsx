"use client";

import { useTranslations } from "next-intl";

/**
 * The amber "canary" pill that sits beside the wordmark (NavBar, sign-in) when
 * the instance is marked CANARY. Rendered only when canary is on — the caller
 * gates it — so it needs no state, just the localized label. The 🐤 is
 * decorative; the word carries the meaning for screen readers and non-emoji
 * platforms.
 */
export default function CanaryBadge({ className }: { className?: string }) {
  const t = useTranslations("Brand");
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-950 ${className ?? ""}`}
      title={t("canaryTooltip")}
      data-testid="canary-badge"
    >
      <span aria-hidden>🐤</span>
      <span>{t("canary")}</span>
    </span>
  );
}
