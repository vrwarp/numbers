"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { parseDollarsToCents } from "@/lib/money";
import { useApiErrorMessage } from "@/lib/use-api-error";
import { useModalDismiss } from "@/lib/use-modal-dismiss";

/**
 * Shown when the AI couldn't read a receipt: the image sits next to the exact
 * fields extraction is supposed to produce (merchant, date, printed total,
 * refund total, item summary) so the user can transcribe them by hand. Saving
 * PATCHes the claim's receipt route, which stamps the receipt and fills its
 * placeholder line item — the row still needs a ministry + verify afterwards.
 */
export default function ManualEntryDialog({
  claimId,
  receipt,
  imageUrl,
  onSaved,
  onSkip,
}: {
  claimId: string;
  receipt: { id: string; originalName: string; mimeType: string };
  imageUrl: string;
  onSaved: () => Promise<void>;
  onSkip: () => void;
}) {
  const t = useTranslations("ManualEntry");
  const tCommon = useTranslations("Common");
  const apiError = useApiErrorMessage();
  const [merchant, setMerchant] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [total, setTotal] = useState("");
  const [refund, setRefund] = useState("0");
  const [summary, setSummary] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Escape defers the receipt (same as "Skip for now") — never mid-save.
  useModalDismiss(dialogRef, () => {
    if (!saving) onSkip();
  });

  function centsOrNull(input: string): number | null {
    try {
      return parseDollarsToCents(input);
    } catch {
      return null;
    }
  }

  const totalCents = centsOrNull(total);
  const refundCents = centsOrNull(refund);
  const canSave =
    merchant.trim() !== "" &&
    summary.trim() !== "" &&
    totalCents !== null &&
    refundCents !== null &&
    refundCents >= 0;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/reimbursements/${claimId}/receipts/${receipt.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant: merchant.trim(),
          purchaseDate,
          totalAmount: totalCents! / 100,
          refundAmount: refundCents! / 100,
          summary: summary.trim(),
        }),
      });
      if (!res.ok) throw new Error(apiError(await res.json().catch(() => null), t("saveFailed")));
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
      setSaving(false);
    }
  }

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal
      data-testid="manual-entry-dialog"
    >
      <div className="card flex max-h-[90dvh] w-full max-w-3xl flex-col p-6">
        <div>
          <h2 className="font-bold">{t("title")}</h2>
          <p className="text-sm text-stone-500">
            {t.rich("intro", {
              name: receipt.originalName,
              strong: (chunks) => <span className="font-medium">{chunks}</span>,
            })}
          </p>
        </div>

        {error && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
            {error}
          </div>
        )}

        <div className="mt-4 grid flex-1 gap-4 overflow-y-auto md:grid-cols-2">
          <div className="max-h-[60dvh] overflow-y-auto rounded-lg border border-stone-100 bg-stone-50/50">
            {receipt.mimeType === "application/pdf" ? (
              <object data={imageUrl} type="application/pdf" className="h-[60dvh] w-full">
                <a href={imageUrl} className="block p-4 text-indigo-600 underline">
                  {t("openPdf")}
                </a>
              </object>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt={receipt.originalName} className="w-full" />
            )}
          </div>

          <div className="space-y-3">
            <label className="block text-sm font-medium">
              {t("merchant")}
              <input
                className="input mt-1"
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
                placeholder={t("merchantPlaceholder")}
                autoFocus
                data-testid="manual-merchant"
              />
            </label>
            <label className="block text-sm font-medium">
              {t("purchaseDate")} <span className="font-normal text-stone-400">{t("optional")}</span>
              <input
                type="date"
                className="input mt-1"
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
                data-testid="manual-date"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm font-medium">
                {t("printedTotal")}
                <input
                  className="input mt-1"
                  value={total}
                  onChange={(e) => setTotal(e.target.value)}
                  inputMode="decimal"
                  placeholder={t("amountPlaceholder")}
                  data-testid="manual-total"
                />
              </label>
              <label className="block text-sm font-medium">
                {t("refunded")}
                <input
                  className="input mt-1"
                  value={refund}
                  onChange={(e) => setRefund(e.target.value)}
                  inputMode="decimal"
                  placeholder={t("amountPlaceholder")}
                  data-testid="manual-refund"
                />
              </label>
            </div>
            <label className="block text-sm font-medium">
              {t("summary")}
              <textarea
                className="input mt-1 field-sizing-content"
                rows={2}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder={t("summaryPlaceholder")}
                maxLength={200}
                data-testid="manual-summary"
              />
            </label>
            {totalCents !== null && refundCents !== null && (
              <p className="text-xs text-stone-500" data-testid="manual-net">
                {t.rich("rowAmount", {
                  amount: `$${((totalCents - refundCents) / 100).toFixed(2)}`,
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
                {refundCents > 0 && t("totalMinusRefunded")}
              </p>
            )}
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            className="btn-secondary"
            onClick={onSkip}
            disabled={saving}
            data-testid="manual-skip"
          >
            {t("later")}
          </button>
          <button
            className="btn-primary"
            onClick={save}
            disabled={!canSave || saving}
            data-testid="manual-save"
          >
            {saving ? tCommon("saving") : t("saveDetails")}
          </button>
        </div>
      </div>
    </div>
  );
}
