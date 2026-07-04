"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MINISTRY_GROUPS, isKnownMinistry } from "@/lib/ministries";
import { centsToDollarString, formatCents, parseDollarsToCents, subtotalCents } from "@/lib/money";
import ReceiptImageEditor from "@/components/ReceiptImageEditor";

interface LineItem {
  id: string;
  receiptId: string;
  description: string;
  amountCents: number;
  ministry: string;
  event: string;
  isVerified: boolean;
  isExcluded: boolean;
  sortOrder: number;
}

interface ReceiptInfo {
  id: string;
  originalName: string;
  mimeType: string;
  note: string;
  merchant: string;
  purchaseDate: string; // "YYYY-MM-DD" or ""
  extractedTotalCents: number | null;
  extractedRefundCents: number | null;
}

interface ReceiptRef {
  receiptId: string;
  receipt: ReceiptInfo;
}

interface Claim {
  id: string;
  status: "draft" | "generated";
  totalCents: number;
  createdAt: string;
  lineItems: LineItem[];
  receipts: ReceiptRef[];
}

/** "Amazon — 06/04/2026", falling back to the uploaded file name until extraction runs. */
function receiptLabel(receipt: ReceiptInfo): string {
  if (!receipt.merchant) return receipt.originalName;
  const m = receipt.purchaseDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${receipt.merchant} — ${m[2]}/${m[3]}/${m[1]}` : receipt.merchant;
}

export default function ReviewClaim({ claimId }: { claimId: string }) {
  const router = useRouter();
  const [claim, setClaim] = useState<Claim | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [splitItem, setSplitItem] = useState<LineItem | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [editingReceiptId, setEditingReceiptId] = useState<string | null>(null);
  // Bumped after a rotate/crop so the <img> cache-busts past the file route's max-age.
  const [fileVersions, setFileVersions] = useState<Record<string, number>>({});

  const fileUrl = useCallback(
    (receiptId: string) =>
      `/api/receipts/${receiptId}/file${fileVersions[receiptId] ? `?v=${fileVersions[receiptId]}` : ""}`,
    [fileVersions]
  );

  const load = useCallback(async () => {
    const res = await fetch(`/api/reimbursements/${claimId}`);
    if (!res.ok) {
      setError((await res.json()).error ?? "Failed to load claim");
      return;
    }
    setClaim((await res.json()).reimbursement);
  }, [claimId]);

  useEffect(() => {
    load();
  }, [load]);

  const patchItem = useCallback(
    async (itemId: string, patch: Partial<LineItem>) => {
      // Optimistic update; server response is authoritative.
      setClaim((prev) =>
        prev
          ? { ...prev, lineItems: prev.lineItems.map((it) => (it.id === itemId ? { ...it, ...patch } : it)) }
          : prev
      );
      const res = await fetch(`/api/line-items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setError((await res.json()).error ?? "Update failed");
        await load();
        return;
      }
      const { lineItem, totalCents } = await res.json();
      setClaim((prev) =>
        prev
          ? {
              ...prev,
              totalCents,
              lineItems: prev.lineItems.map((it) => (it.id === itemId ? lineItem : it)),
            }
          : prev
      );
    },
    [load]
  );

  const mergeUp = useCallback(
    async (itemId: string) => {
      const res = await fetch(`/api/line-items/${itemId}/merge`, { method: "POST" });
      if (!res.ok) {
        setError((await res.json()).error ?? "Merge failed");
        return;
      }
      await load();
    },
    [load]
  );

  const groups = useMemo(() => {
    if (!claim) return [];
    return claim.receipts.map((ref) => ({
      receipt: ref.receipt,
      items: claim.lineItems
        .filter((it) => it.receiptId === ref.receiptId)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    }));
  }, [claim]);

  if (error && !claim) {
    return (
      <div className="card border-red-200 bg-red-50 p-6 text-red-800">
        {error} — <Link href="/claims" className="underline">back to claims</Link>
      </div>
    );
  }
  if (!claim) return <p className="text-sm text-stone-500">Loading claim…</p>;

  const activeItems = claim.lineItems.filter((it) => !it.isExcluded);
  const verifiedCount = activeItems.filter((it) => it.isVerified).length;
  const allVerified = activeItems.length > 0 && verifiedCount === activeItems.length;
  const isDraft = claim.status === "draft";

  async function generatePdf() {
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reimbursements/${claim!.id}/pdf`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error ?? "PDF generation failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cfcc-reimbursement-${claim!.id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "PDF generation failed");
    } finally {
      setDownloading(false);
    }
  }

  async function revertClaim() {
    if (
      !confirm(
        "Revert this claim to draft? Only do this if you have NOT filed the printed form yet. Rows become editable again and the receipts leave “processed”."
      )
    )
      return;
    const res = await fetch(`/api/reimbursements/${claim!.id}/revert`, { method: "POST" });
    if (!res.ok) setError((await res.json()).error ?? "Revert failed");
    await load();
  }

  async function removeReceipt(receiptId: string) {
    if (
      !confirm(
        "Remove this receipt from the claim? Its rows are deleted and the receipt returns to your Shoebox."
      )
    )
      return;
    const res = await fetch(`/api/reimbursements/${claim!.id}/receipts/${receiptId}`, {
      method: "DELETE",
    });
    if (!res.ok) setError((await res.json()).error ?? "Remove failed");
    await load();
  }

  async function deleteClaim() {
    if (!confirm("Discard this draft claim? Receipts return to your Shoebox.")) return;
    const res = await fetch(`/api/reimbursements/${claim!.id}`, { method: "DELETE" });
    if (res.ok) router.push("/shoebox");
    else setError((await res.json()).error ?? "Delete failed");
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">
            Review claim{" "}
            <span
              className={`ml-1 align-middle rounded-full px-3 py-1 text-xs font-semibold ${
                isDraft ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"
              }`}
              data-testid="claim-status"
            >
              {isDraft ? "Draft" : "Generated"}
            </span>
          </h1>
          <p className="text-sm text-stone-500">
            Check each amount against what you actually paid, pick a ministry, then check it off.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isDraft && (
            <button className="btn-secondary" onClick={deleteClaim} data-testid="discard-claim">
              Discard
            </button>
          )}
          {!isDraft && (
            <button className="btn-secondary" onClick={revertClaim} data-testid="revert-claim">
              ↩ Revert to draft
            </button>
          )}
          <button
            className="btn-primary"
            onClick={generatePdf}
            disabled={(isDraft && !allVerified) || downloading}
            data-testid="generate-pdf"
            title={isDraft && !allVerified ? "Verify every row first" : undefined}
          >
            {downloading ? "Building PDF…" : isDraft ? "⬇ Generate PDF" : "⬇ Download PDF again"}
          </button>
        </div>
      </div>

      {isDraft && (
        <div className="card flex items-center gap-3 p-3" data-testid="verify-progress">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-stone-200">
            <div
              className="h-full rounded-full bg-indigo-600 transition-all"
              style={{ width: activeItems.length ? `${(verifiedCount / activeItems.length) * 100}%` : "0%" }}
            />
          </div>
          <span className="whitespace-nowrap text-sm font-medium text-stone-600">
            {verifiedCount} / {activeItems.length} verified
          </span>
        </div>
      )}

      {error && (
        <div className="card border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}

      {/* One card per receipt: the image and its digitized rows travel together
          (rows are 1:1 with receipts; splitting is the only multiplier), so
          there are no independently scrolling columns to keep in sync. */}
      <div className="space-y-4">
        {groups.map((group, gi) => (
          <div key={group.receipt.id} className="card overflow-hidden" data-testid={`group-${group.receipt.id}`}>
            {/* Wraps to two lines on phones: title first, subtotal + actions below. */}
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-stone-100 bg-stone-50 px-4 py-2">
              <span className="w-full min-w-0 text-sm font-semibold text-stone-700 sm:w-auto">
                Receipt {gi + 1}: {receiptLabel(group.receipt)}
                {group.receipt.note && (
                  <span className="ml-1 font-normal text-stone-500">· {group.receipt.note}</span>
                )}
              </span>
              <span className="ml-auto flex items-center gap-2">
                <span
                  className="whitespace-nowrap text-sm font-bold"
                  data-testid={`subtotal-${group.receipt.id}`}
                >
                  Subtotal: {formatCents(subtotalCents(group.items))}
                </span>
                {isDraft && group.receipt.mimeType !== "application/pdf" && (
                  <button
                    className="whitespace-nowrap rounded px-2 py-1 text-xs font-normal text-stone-500 hover:bg-stone-100 hover:text-stone-700"
                    onClick={() => setEditingReceiptId(group.receipt.id)}
                    title="Rotate or crop this receipt photo"
                    data-testid={`edit-image-${group.receipt.id}`}
                  >
                    ✂ Rotate / crop
                  </button>
                )}
                {isDraft && (
                  <button
                    className="whitespace-nowrap rounded px-2 py-1 text-xs text-stone-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                    disabled={claim.receipts.length === 1}
                    title={
                      claim.receipts.length === 1
                        ? "This is the only receipt — discard the claim instead"
                        : "Remove receipt from claim (returns to Shoebox)"
                    }
                    onClick={() => removeReceipt(group.receipt.id)}
                    data-testid={`remove-receipt-${group.receipt.id}`}
                  >
                    ✕ Remove
                  </button>
                )}
              </span>
            </div>
            {(group.receipt.extractedRefundCents ?? 0) > 0 && (
              <div
                className="border-b border-stone-100 bg-amber-50 px-4 py-2 text-xs text-amber-900"
                data-testid={`derivation-${group.receipt.id}`}
              >
                Charged {formatCents(group.receipt.extractedTotalCents ?? 0)} − refunded{" "}
                {formatCents(group.receipt.extractedRefundCents!)} → suggested{" "}
                {formatCents((group.receipt.extractedTotalCents ?? 0) - group.receipt.extractedRefundCents!)}
              </div>
            )}
            <div className="grid lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <div className="max-h-[75vh] overflow-y-auto border-b border-stone-100 bg-stone-50/50 lg:border-b-0 lg:border-r">
                {group.receipt.mimeType === "application/pdf" ? (
                  <object
                    data={`/api/receipts/${group.receipt.id}/file`}
                    type="application/pdf"
                    className="h-[480px] w-full"
                  >
                    <a
                      href={`/api/receipts/${group.receipt.id}/file`}
                      className="block p-4 text-indigo-600 underline"
                    >
                      Open PDF receipt
                    </a>
                  </object>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={fileUrl(group.receipt.id)}
                    alt={group.receipt.originalName}
                    className="w-full"
                  />
                )}
              </div>
              {/* Sticky so the fields stay beside a tall receipt photo while it scrolls. */}
              <div className="lg:sticky lg:top-20 lg:self-start">
                <ul className="divide-y divide-stone-100">
                  {group.items.map((item, idx) => (
                    <LineItemRow
                      key={item.id}
                      item={item}
                      readOnly={!isDraft}
                      onPatch={patchItem}
                      onSplit={() => setSplitItem(item)}
                      canMergeUp={idx > 0}
                      mergeUpBlocked={idx > 0 && group.items[idx - 1].isExcluded}
                      onMergeUp={() => mergeUp(item.id)}
                    />
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ))}

        <div className="card flex items-center justify-between bg-indigo-50 p-4">
          <span className="font-semibold text-indigo-900">Claim total</span>
          <span className="text-xl font-bold text-indigo-900" data-testid="claim-total">
            {formatCents(claim.totalCents)}
          </span>
        </div>
      </div>

      {editingReceiptId && (
        <ReceiptImageEditor
          receiptId={editingReceiptId}
          reimbursementId={claim.id}
          src={fileUrl(editingReceiptId)}
          onClose={() => setEditingReceiptId(null)}
          onSaved={() => {
            setFileVersions((prev) => ({
              ...prev,
              [editingReceiptId]: (prev[editingReceiptId] ?? 0) + 1,
            }));
            setEditingReceiptId(null);
          }}
        />
      )}

      {splitItem && (
        <SplitDialog
          item={splitItem}
          onClose={() => setSplitItem(null)}
          onDone={async () => {
            setSplitItem(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

// Sentinel select value for the free-text ministry escape hatch; never stored.
const OTHER_MINISTRY = "__other__";

function LineItemRow({
  item,
  readOnly,
  onPatch,
  onSplit,
  canMergeUp,
  mergeUpBlocked,
  onMergeUp,
}: {
  item: LineItem;
  readOnly: boolean;
  onPatch: (id: string, patch: Partial<LineItem>) => Promise<void>;
  onSplit: () => void;
  /** True when a row from the same receipt sits directly above this one. */
  canMergeUp: boolean;
  /** True when the row above is excluded (server refuses the merge). */
  mergeUpBlocked: boolean;
  onMergeUp: () => void;
}) {
  const negative = item.amountCents < 0;
  const excluded = item.isExcluded;
  // "Other…" stays selected while the custom text box is still empty; a saved
  // value that isn't in the budget list (custom or legacy) also renders as Other.
  const [otherPicked, setOtherPicked] = useState(false);
  const showOtherInput = otherPicked || (!!item.ministry && !isKnownMinistry(item.ministry));

  return (
    <li
      className={`px-4 py-3 ${excluded ? "bg-stone-50 opacity-60" : ""}`}
      data-testid={`row-${item.id}`}
      data-description={item.description}
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <textarea
            key={`desc-${item.id}-${item.description}`}
            rows={2}
            // field-sizing auto-grows to the content where supported; rows=2 is the fallback.
            className={`input flex-1 resize-y field-sizing-content ${excluded ? "line-through" : ""} ${negative ? "text-red-700" : ""}`}
            defaultValue={item.description}
            disabled={excluded || readOnly}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== item.description) onPatch(item.id, { description: v });
            }}
            aria-label="Description"
            data-testid={`desc-${item.id}`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input w-auto max-w-full"
            value={showOtherInput ? OTHER_MINISTRY : item.ministry}
            disabled={excluded || readOnly}
            onChange={(e) => {
              if (e.target.value === OTHER_MINISTRY) {
                setOtherPicked(true);
                // Clear the stored category so the verify gate stays honest
                // until the custom text is actually typed.
                if (item.ministry) onPatch(item.id, { ministry: "" });
              } else {
                setOtherPicked(false);
                onPatch(item.id, { ministry: e.target.value });
              }
            }}
            aria-label="Ministry"
            data-testid={`ministry-${item.id}`}
          >
            <option value="">— pick ministry —</option>
            {MINISTRY_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </optgroup>
            ))}
            <option value={OTHER_MINISTRY}>Other…</option>
          </select>
          {showOtherInput && (
            <input
              key={`other-${item.id}-${item.ministry}`}
              className="input w-44"
              defaultValue={isKnownMinistry(item.ministry) ? "" : item.ministry}
              placeholder="Custom ministry"
              disabled={excluded || readOnly}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== item.ministry) onPatch(item.id, { ministry: v });
              }}
              aria-label="Custom ministry"
              data-testid={`ministry-other-${item.id}`}
            />
          )}
          <input
            key={`event-${item.id}-${item.event}`}
            className="input w-40"
            defaultValue={item.event}
            placeholder="Event (optional)"
            disabled={excluded || readOnly}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== item.event) onPatch(item.id, { event: v });
            }}
            aria-label="Event"
            data-testid={`event-${item.id}`}
          />
          <label className="flex items-center gap-1 text-xs text-stone-500">
            $
            <input
              key={`amt-${item.id}-${item.amountCents}`}
              className={`input w-24 font-semibold ${negative ? "text-red-700" : ""} ${excluded ? "line-through" : ""}`}
              defaultValue={centsToDollarString(item.amountCents)}
              disabled={excluded || readOnly}
              onBlur={(e) => {
                try {
                  const cents = parseDollarsToCents(e.target.value);
                  if (cents !== item.amountCents) onPatch(item.id, { amountCents: cents });
                } catch {
                  e.target.value = centsToDollarString(item.amountCents);
                }
              }}
              aria-label="Amount"
              data-testid={`amount-${item.id}`}
            />
          </label>
          {negative && (
            <span className="rounded bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">
              REFUND
            </span>
          )}
        </div>
        {/* Action line: row operations on the left, confirm on the right —
            always the last line of the row. */}
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-1 pt-1">
            <button
              className="rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 disabled:opacity-30"
              onClick={onSplit}
              disabled={excluded}
              title="Split into two rows"
              data-testid={`split-${item.id}`}
            >
              ⑂ Split
            </button>
            {canMergeUp && (
              <button
                className="rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 disabled:opacity-30"
                onClick={onMergeUp}
                disabled={excluded || mergeUpBlocked}
                title={
                  excluded || mergeUpBlocked
                    ? "Restore the excluded row before merging"
                    : "Merge back into the row above (undo split)"
                }
                data-testid={`merge-${item.id}`}
              >
                ⤴ Merge up
              </button>
            )}
            <button
              className="rounded px-2 py-1 text-xs text-stone-500 hover:bg-red-50 hover:text-red-600"
              onClick={() => onPatch(item.id, { isExcluded: !excluded, isVerified: false })}
              title={excluded ? "Restore item" : "Exclude item (personal / not reimbursable)"}
              data-testid={`exclude-${item.id}`}
            >
              {excluded ? "↩ Restore" : "🗑 Exclude"}
            </button>
            {!excluded && (
              <button
                className={`ml-auto flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
                  item.isVerified
                    ? "border border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-100"
                    : "bg-emerald-600 text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
                }`}
                // Cosmetic: the line-items PATCH route is what actually refuses to
                // verify a row without a ministry.
                disabled={!item.isVerified && !item.ministry}
                title={!item.isVerified && !item.ministry ? "Choose a ministry first" : undefined}
                onClick={() => onPatch(item.id, { isVerified: !item.isVerified })}
                aria-pressed={item.isVerified}
                data-testid={`verify-${item.id}`}
              >
                {item.isVerified
                  ? "✓ Verified · Undo"
                  : `✓ Confirm ${formatCents(item.amountCents)}`}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function SplitDialog({
  item,
  onClose,
  onDone,
}: {
  item: LineItem;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [firstText, setFirstText] = useState(() => {
    const sign = item.amountCents < 0 ? -1 : 1;
    return centsToDollarString(sign * Math.ceil(Math.abs(item.amountCents) / 2));
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  let firstCents: number | null = null;
  try {
    firstCents = parseDollarsToCents(firstText);
  } catch {
    firstCents = null;
  }
  const secondCents = firstCents !== null ? item.amountCents - firstCents : null;

  async function submit() {
    if (firstCents === null) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/line-items/${item.id}/split`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstAmountCents: firstCents }),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? "Split failed");
      setBusy(false);
      return;
    }
    await onDone();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal>
      <div className="card w-full max-w-sm p-6">
        <h2 className="font-bold">Split line item</h2>
        <p className="mt-1 truncate text-sm text-stone-500">{item.description}</p>
        <p className="text-sm text-stone-500">Total: {formatCents(item.amountCents)}</p>
        <label className="mt-4 block text-sm font-medium">
          First part ($)
          <input
            className="input mt-1"
            value={firstText}
            onChange={(e) => setFirstText(e.target.value)}
            autoFocus
            data-testid="split-first-amount"
          />
        </label>
        <p className="mt-2 text-sm text-stone-600">
          Second part: <strong>{secondCents !== null ? formatCents(secondCents) : "—"}</strong>
        </p>
        {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={submit}
            disabled={busy || firstCents === null || firstCents === 0 || secondCents === 0}
            data-testid="split-confirm"
          >
            Split
          </button>
        </div>
      </div>
    </div>
  );
}
