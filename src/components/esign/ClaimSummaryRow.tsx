"use client";

/**
 * The shared summary line for a claim in the approver inbox and the treasurer
 * finance queue — owner, a one-line subtitle, a dates line, the amount, and a
 * caller-supplied trailing control (chevron or status chip) plus optional
 * leading control (a select checkbox). Both pages render it so their rows read
 * identically whether the row expands a ceremony or opens a certificate.
 */

import { type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { formatCents } from "@/lib/money";
import { useDateLabel } from "@/lib/use-date-label";
import { claimSubtitle } from "@/lib/claim-subtitle";

export interface ClaimRowData {
  ownerName: string;
  claimDescription: string;
  totalCents: number;
  status: string;
  submittedAt: string | null;
  decidedAt: string | null;
  paidAt: string | null;
  rows: { event: string }[];
}

/** The dates beneath the subtitle: submitted, then the decision, then paid —
 *  only those that exist for the claim's current status. */
function useMetaLine(c: ClaimRowData): string {
  const t = useTranslations("Esign");
  const label = useDateLabel();
  const parts: string[] = [];
  if (c.submittedAt) parts.push(t("metaSubmitted", { date: label(c.submittedAt) }));
  if (c.decidedAt && (c.status === "approved" || c.status === "paid")) {
    parts.push(t("metaApproved", { date: label(c.decidedAt) }));
  } else if (c.decidedAt && c.status === "rejected") {
    parts.push(t("metaRejected", { date: label(c.decidedAt) }));
  }
  if (c.paidAt && c.status === "paid") parts.push(t("metaPaid", { date: label(c.paidAt) }));
  return parts.join(" · ");
}

export default function ClaimSummaryRow({
  claim,
  leading,
  trailing,
}: {
  claim: ClaimRowData;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const tEsign = useTranslations("Esign");
  const subtitle = claimSubtitle(claim, (count) => tEsign("itemsCount", { count }));
  const meta = useMetaLine(claim);
  return (
    // min-w-0 so the row can shrink when it is itself a flex child (the finance
    // paid row nests it inside a flex toggle button next to a View link); without
    // it the row keeps its content width and the amount overflows onto that link
    // on narrow screens. A no-op in the block-parent inbox/queue rows.
    <div className="flex w-full min-w-0 items-center gap-3">
      {leading}
      {/* min-w-0 + truncate so long text shrinks instead of pushing the amount
          off the card (flex items default to min-width:auto). */}
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate font-semibold">{claim.ownerName}</div>
        <div className="truncate text-sm text-stone-500">{subtitle}</div>
        {meta && <div className="truncate text-xs text-stone-400">{meta}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-lg font-bold">{formatCents(claim.totalCents)}</span>
        {trailing}
      </div>
    </div>
  );
}
