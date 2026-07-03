"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MINISTRIES } from "@/lib/ministries";
import { centsToDollarString, formatCents, parseDollarsToCents, subtotalCents } from "@/lib/money";

interface LineItem {
  id: string;
  receiptId: string;
  description: string;
  quantity: number;
  amountCents: number;
  ministry: string;
  isVerified: boolean;
  isExcluded: boolean;
  sortOrder: number;
}

interface ReceiptRef {
  receiptId: string;
  receipt: { id: string; originalName: string; mimeType: string };
}

interface Claim {
  id: string;
  status: "draft" | "generated";
  totalCents: number;
  createdAt: string;
  lineItems: LineItem[];
  receipts: ReceiptRef[];
}

export default function ReviewClaim({ claimId }: { claimId: string }) {
  const router = useRouter();
  const [claim, setClaim] = useState<Claim | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [splitItem, setSplitItem] = useState<LineItem | null>(null);
  const [downloading, setDownloading] = useState(false);

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
            Compare every row against the receipt on the left, then check it off.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isDraft && (
            <button className="btn-secondary" onClick={deleteClaim} data-testid="discard-claim">
              Discard
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

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Left: original receipts */}
        <div className="space-y-4 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-1">
          {claim.receipts.map((ref, i) => (
            <div key={ref.receiptId} className="card overflow-hidden">
              <div className="border-b border-stone-100 px-3 py-2 text-xs font-semibold text-stone-500">
                Receipt {i + 1}: {ref.receipt.originalName}
              </div>
              {ref.receipt.mimeType === "application/pdf" ? (
                <object
                  data={`/api/receipts/${ref.receipt.id}/file`}
                  type="application/pdf"
                  className="h-[480px] w-full"
                >
                  <a href={`/api/receipts/${ref.receipt.id}/file`} className="block p-4 text-indigo-600 underline">
                    Open PDF receipt
                  </a>
                </object>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/receipts/${ref.receipt.id}/file`}
                  alt={ref.receipt.originalName}
                  className="w-full"
                />
              )}
            </div>
          ))}
        </div>

        {/* Right: line items grouped by receipt */}
        <div className="space-y-4">
          {groups.map((group, gi) => (
            <div key={group.receipt.id} className="card overflow-hidden" data-testid={`group-${group.receipt.id}`}>
              <div className="flex items-center justify-between border-b border-stone-100 bg-stone-50 px-4 py-2">
                <span className="text-sm font-semibold text-stone-700">
                  Receipt {gi + 1}: {group.receipt.originalName}
                </span>
                <span className="text-sm font-bold" data-testid={`subtotal-${group.receipt.id}`}>
                  Subtotal: {formatCents(subtotalCents(group.items))}
                </span>
              </div>
              <ul className="divide-y divide-stone-100">
                {group.items.map((item) => (
                  <LineItemRow
                    key={item.id}
                    item={item}
                    readOnly={!isDraft}
                    onPatch={patchItem}
                    onSplit={() => setSplitItem(item)}
                  />
                ))}
              </ul>
            </div>
          ))}

          <div className="card flex items-center justify-between bg-indigo-50 p-4">
            <span className="font-semibold text-indigo-900">Claim total</span>
            <span className="text-xl font-bold text-indigo-900" data-testid="claim-total">
              {formatCents(claim.totalCents)}
            </span>
          </div>
        </div>
      </div>

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

function LineItemRow({
  item,
  readOnly,
  onPatch,
  onSplit,
}: {
  item: LineItem;
  readOnly: boolean;
  onPatch: (id: string, patch: Partial<LineItem>) => Promise<void>;
  onSplit: () => void;
}) {
  const negative = item.amountCents < 0;
  const excluded = item.isExcluded;

  return (
    <li
      className={`px-4 py-3 ${excluded ? "bg-stone-50 opacity-60" : ""}`}
      data-testid={`row-${item.id}`}
      data-description={item.description}
    >
      <div className="flex items-start gap-3">
        {/* Verify checkmark */}
        <button
          className={`mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold transition-colors ${
            item.isVerified
              ? "border-emerald-600 bg-emerald-600 text-white"
              : "border-stone-300 bg-white text-transparent hover:border-emerald-400"
          } ${excluded || readOnly ? "invisible" : ""} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-stone-300`}
          // Cosmetic: the line-items PATCH route is what actually refuses to
          // verify a row without a ministry.
          disabled={!item.isVerified && !item.ministry}
          title={!item.isVerified && !item.ministry ? "Choose a ministry first" : undefined}
          onClick={() => onPatch(item.id, { isVerified: !item.isVerified })}
          aria-label={item.isVerified ? "Mark unverified" : "Approve row"}
          aria-pressed={item.isVerified}
          data-testid={`verify-${item.id}`}
        >
          ✓
        </button>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <input
              key={`desc-${item.id}-${item.description}`}
              className={`input flex-1 ${excluded ? "line-through" : ""} ${negative ? "text-red-700" : ""}`}
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
              className="input w-auto"
              value={item.ministry}
              disabled={excluded || readOnly}
              onChange={(e) => onPatch(item.id, { ministry: e.target.value })}
              aria-label="Ministry"
              data-testid={`ministry-${item.id}`}
            >
              {!MINISTRIES.includes(item.ministry as (typeof MINISTRIES)[number]) && (
                <option value={item.ministry}>{item.ministry || "— pick ministry —"}</option>
              )}
              {MINISTRIES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-stone-500">
              Qty
              <input
                key={`qty-${item.id}-${item.quantity}`}
                type="number"
                step="any"
                className={`input w-20 ${negative ? "text-red-700" : ""}`}
                defaultValue={item.quantity}
                disabled={excluded || readOnly}
                onBlur={(e) => {
                  const v = parseFloat(e.target.value);
                  if (Number.isFinite(v) && v !== item.quantity) onPatch(item.id, { quantity: v });
                }}
                aria-label="Quantity"
                data-testid={`qty-${item.id}`}
              />
            </label>
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
        </div>

        {!readOnly && (
          <div className="flex shrink-0 flex-col gap-1">
            <button
              className="rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 disabled:opacity-30"
              onClick={onSplit}
              disabled={excluded}
              title="Split into two rows"
              data-testid={`split-${item.id}`}
            >
              ⑂ Split
            </button>
            <button
              className="rounded px-2 py-1 text-xs text-stone-500 hover:bg-red-50 hover:text-red-600"
              onClick={() => onPatch(item.id, { isExcluded: !excluded, isVerified: false })}
              title={excluded ? "Restore item" : "Exclude item (personal / not reimbursable)"}
              data-testid={`exclude-${item.id}`}
            >
              {excluded ? "↩ Restore" : "🗑 Exclude"}
            </button>
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
