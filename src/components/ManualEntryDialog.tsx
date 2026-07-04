"use client";

import { useState } from "react";
import { parseDollarsToCents } from "@/lib/money";

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
  const [merchant, setMerchant] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [total, setTotal] = useState("");
  const [refund, setRefund] = useState("0");
  const [summary, setSummary] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save the details");
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the details");
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal
      data-testid="manual-entry-dialog"
    >
      <div className="card flex max-h-[90vh] w-full max-w-3xl flex-col p-6">
        <div>
          <h2 className="font-bold">Enter this receipt&apos;s details</h2>
          <p className="text-sm text-stone-500">
            The AI couldn&apos;t read <span className="font-medium">{receipt.originalName}</span>.
            Type in what&apos;s printed on it so the row can be verified.
          </p>
        </div>

        {error && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
            {error}
          </div>
        )}

        <div className="mt-4 grid flex-1 gap-4 overflow-y-auto md:grid-cols-2">
          <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-stone-100 bg-stone-50/50">
            {receipt.mimeType === "application/pdf" ? (
              <object data={imageUrl} type="application/pdf" className="h-[60vh] w-full">
                <a href={imageUrl} className="block p-4 text-indigo-600 underline">
                  Open PDF receipt
                </a>
              </object>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt={receipt.originalName} className="w-full" />
            )}
          </div>

          <div className="space-y-3">
            <label className="block text-sm font-medium">
              Merchant
              <input
                className="input mt-1"
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
                placeholder="e.g. Costco Wholesale"
                autoFocus
                data-testid="manual-merchant"
              />
            </label>
            <label className="block text-sm font-medium">
              Purchase date <span className="font-normal text-stone-400">(optional)</span>
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
                Printed total ($)
                <input
                  className="input mt-1"
                  value={total}
                  onChange={(e) => setTotal(e.target.value)}
                  inputMode="decimal"
                  placeholder="0.00"
                  data-testid="manual-total"
                />
              </label>
              <label className="block text-sm font-medium">
                Refunded ($)
                <input
                  className="input mt-1"
                  value={refund}
                  onChange={(e) => setRefund(e.target.value)}
                  inputMode="decimal"
                  placeholder="0.00"
                  data-testid="manual-refund"
                />
              </label>
            </div>
            <label className="block text-sm font-medium">
              Item summary
              <textarea
                className="input mt-1 field-sizing-content"
                rows={2}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="e.g. Paper towels, snack variety pack, folding table"
                maxLength={200}
                data-testid="manual-summary"
              />
            </label>
            {totalCents !== null && refundCents !== null && (
              <p className="text-xs text-stone-500" data-testid="manual-net">
                Row amount: <strong>${((totalCents - refundCents) / 100).toFixed(2)}</strong>
                {refundCents > 0 && " (total − refunded)"}
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
            I&apos;ll do it later
          </button>
          <button
            className="btn-primary"
            onClick={save}
            disabled={!canSave || saving}
            data-testid="manual-save"
          >
            {saving ? "Saving…" : "Save details"}
          </button>
        </div>
      </div>
    </div>
  );
}
