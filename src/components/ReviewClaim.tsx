"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  MINISTRY_GROUPS,
  formatMinistryEvent,
  isKnownMinistry,
  mostCommonMinistryEvent,
} from "@/lib/ministries";
import { centsToDollarString, formatCents, parseDollarsToCents, subtotalCents } from "@/lib/money";
import ReceiptImageEditor from "@/components/ReceiptImageEditor";
import AddReceiptsDialog from "@/components/AddReceiptsDialog";
import ManualEntryDialog from "@/components/ManualEntryDialog";
import PdfReceiptPreview from "@/components/PdfReceiptPreview";

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
  // Single-ministry mode: claimMinistry/claimEvent mirror onto every active
  // row (the server fans out on PATCH); rows keep their own values as the
  // source of truth for the PDF.
  singleMinistry: boolean;
  claimMinistry: string;
  claimEvent: string;
  claimDescription: string;
  createdAt: string;
  lineItems: LineItem[];
  receipts: ReceiptRef[];
}

type ClaimSettingsPatch = Partial<
  Pick<Claim, "singleMinistry" | "claimMinistry" | "claimEvent" | "claimDescription">
>;

interface MinistrySuggestion {
  ministry: string | null;
  event: string | null;
  rationale: string;
}

/** Pre-fan-out values of the rows a claim-level ministry change touched. */
interface FanOutUndo {
  restoreClaim: Pick<Claim, "singleMinistry" | "claimMinistry" | "claimEvent">;
  rows: Pick<LineItem, "id" | "ministry" | "event" | "isVerified">[];
  message: string;
  source: "ai" | "manual";
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
  const [addingReceipts, setAddingReceipts] = useState(false);
  // Receipt whose failed-extraction placeholder is being filled in by hand, and
  // the set the user chose to defer (so the modal doesn't reopen on them).
  const [manualEntryReceiptId, setManualEntryReceiptId] = useState<string | null>(null);
  const [deferredManual, setDeferredManual] = useState<Set<string>>(new Set());
  // Bumped after a rotate/crop so the <img> cache-busts past the file route's max-age.
  const [fileVersions, setFileVersions] = useState<Record<string, number>>({});
  // Row whose confirm button is pulsing after a click on the gated PDF button.
  const [nudgedItemId, setNudgedItemId] = useState<string | null>(null);
  // Single-ministry mode state: the AI's pending suggestion (never applied
  // until the user clicks Apply), the multi→single confirm dialog, the undo
  // toast for the last fan-out, and the split-needs-multi-mode gate.
  const [pendingSuggestion, setPendingSuggestion] = useState<MinistrySuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [modeSwitchPrompt, setModeSwitchPrompt] = useState<{
    adopt: { ministry: string; event: string };
    distinct: number;
    unverify: number;
  } | null>(null);
  const [fanOutUndo, setFanOutUndo] = useState<FanOutUndo | null>(null);
  const [splitModeItem, setSplitModeItem] = useState<LineItem | null>(null);

  useEffect(() => {
    if (!nudgedItemId) return;
    const timer = setTimeout(() => setNudgedItemId(null), 3500);
    return () => clearTimeout(timer);
  }, [nudgedItemId]);

  useEffect(() => {
    if (!fanOutUndo || fanOutUndo.source !== "manual") return;
    const timer = setTimeout(() => setFanOutUndo(null), 15_000);
    return () => clearTimeout(timer);
  }, [fanOutUndo]);

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

  // Mutations run strictly one at a time. Without this, picking a ministry and
  // clicking Confirm in quick succession races: the verify PATCH can reach the
  // server before the ministry PATCH commits (400 "choose a ministry first"),
  // or the ministry response can land after the verify response and overwrite
  // the row with a stale isVerified=false.
  const mutationChain = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const next = mutationChain.current.then(task, task);
    mutationChain.current = next.catch(() => undefined);
    return next;
  }, []);

  const patchItem = useCallback(
    (itemId: string, patch: Partial<LineItem>) => {
      // Clear active suggestion and undo toast if user interacts with a row
      setFanOutUndo((prev) => {
        if (prev?.source === "ai") {
          setPendingSuggestion(null);
        }
        return null;
      });
      // Optimistic update applies immediately; the queued server response is
      // authoritative and arrives in call order.
      setClaim((prev) =>
        prev
          ? { ...prev, lineItems: prev.lineItems.map((it) => (it.id === itemId ? { ...it, ...patch } : it)) }
          : prev
      );
      return enqueue(async () => {
        try {
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
        } catch {
          setError("Update failed");
        }
      });
    },
    [enqueue, load]
  );

  // Claim-level review settings (mode, claim ministry/event, description).
  // The server fans single-mode ministry changes out onto the rows, so the
  // response is the full refreshed claim.
  const patchClaim = useCallback(
    (patch: ClaimSettingsPatch) => {
      setClaim((prev) => (prev ? { ...prev, ...patch } : prev));
      return enqueue(async () => {
        try {
          const res = await fetch(`/api/reimbursements/${claimId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          });
          if (!res.ok) {
            setError((await res.json()).error ?? "Update failed");
            await load();
            return;
          }
          setClaim((await res.json()).reimbursement);
        } catch {
          setError("Update failed");
        }
      });
    },
    [claimId, enqueue, load]
  );

  const mergeUp = useCallback(
    (itemId: string) =>
      enqueue(async () => {
        try {
          const res = await fetch(`/api/line-items/${itemId}/merge`, { method: "POST" });
          if (!res.ok) {
            setError((await res.json()).error ?? "Merge failed");
            return;
          }
          await load();
        } catch {
          setError("Merge failed");
        }
      }),
    [enqueue, load]
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

  // A receipt whose extraction failed shows up as a single empty placeholder
  // row — that's the manual-entry prompt (a real extraction, split or edit all
  // give the row a description).
  const needsManualEntry = useCallback(
    (items: LineItem[]) => items.length === 1 && !items[0].description && !items[0].isExcluded,
    []
  );

  // Walk the user straight into filling a failed receipt as soon as the claim
  // loads — this fires for both the create and add-receipts flows, which both
  // land here — unless they deferred it or another dialog is already open.
  useEffect(() => {
    if (!claim || claim.status !== "draft") return;
    if (manualEntryReceiptId || splitItem || editingReceiptId || addingReceipts) return;
    const pending = groups.find(
      (g) => needsManualEntry(g.items) && !deferredManual.has(g.receipt.id)
    );
    if (pending) setManualEntryReceiptId(pending.receipt.id);
  }, [
    claim,
    groups,
    needsManualEntry,
    deferredManual,
    manualEntryReceiptId,
    splitItem,
    editingReceiptId,
    addingReceipts,
  ]);

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
  const pdfButtonEnabled = !isDraft || allVerified;
  // First unverified row in display order — the nudge target when the gated
  // Generate PDF button is clicked while rows remain unverified.
  const firstUnverified = groups
    .flatMap((g) => g.items)
    .find((it) => !it.isExcluded && !it.isVerified);

  function nudgeFirstUnverified() {
    if (!firstUnverified) return;
    setNudgedItemId(firstUnverified.id);
    document
      .querySelector(`[data-testid="row-${firstUnverified.id}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /**
   * Apply claim-level ministry/event (optionally flipping the mode) and let
   * the server mirror them onto every active row. Rows are updated
   * optimistically, and the pre-change values of every touched row are kept
   * in an undo toast — a fan-out can silently un-verify rows, so it must be
   * one click to take back.
   */
  function fanOutClaimPatch(
    next: {
      singleMinistry?: boolean;
      claimMinistry: string;
      claimEvent: string;
    },
    source: "ai" | "manual" = "manual"
  ) {
    if (!claim) return;
    const touched = claim.lineItems.filter(
      (it) => !it.isExcluded && (it.ministry !== next.claimMinistry || it.event !== next.claimEvent)
    );
    if (touched.length > 0) {
      const label = next.claimMinistry
        ? `“${formatMinistryEvent(next.claimMinistry, next.claimEvent)}”`
        : "no ministry";
      setFanOutUndo({
        restoreClaim: {
          singleMinistry: claim.singleMinistry,
          claimMinistry: claim.claimMinistry,
          claimEvent: claim.claimEvent,
        },
        rows: touched.map(({ id, ministry, event, isVerified }) => ({
          id,
          ministry,
          event,
          isVerified,
        })),
        message: `Set ${label} on ${touched.length} row${touched.length === 1 ? "" : "s"}`,
        source,
      });
      // Optimistic mirror so the row badges don't lag the control.
      setClaim((prev) =>
        prev
          ? {
              ...prev,
              lineItems: prev.lineItems.map((it) =>
                it.isExcluded
                  ? it
                  : {
                      ...it,
                      ministry: next.claimMinistry,
                      event: next.claimEvent,
                      isVerified:
                        it.ministry === next.claimMinistry && it.event === next.claimEvent
                          ? it.isVerified
                          : false,
                    }
              ),
            }
          : prev
      );
    }
    return patchClaim({
      singleMinistry: next.singleMinistry ?? claim.singleMinistry,
      claimMinistry: next.claimMinistry,
      claimEvent: next.claimEvent,
    });
  }

  /** Put the touched rows (and the claim settings) back the way they were. */
  function undoFanOut() {
    const undo = fanOutUndo;
    if (!undo) return;
    setFanOutUndo(null);
    patchClaim(undo.restoreClaim);
    for (const row of undo.rows) {
      patchItem(row.id, { ministry: row.ministry, event: row.event, isVerified: row.isVerified });
    }
  }

  /** Multi → single: adopt the most common row value, confirming when rows diverge. */
  function switchToSingle() {
    if (!claim || claim.singleMinistry) return;
    const adopt = mostCommonMinistryEvent(claim.lineItems);
    const active = claim.lineItems.filter((it) => !it.isExcluded);
    const touched = active.filter(
      (it) => it.ministry !== adopt.ministry || it.event !== adopt.event
    );
    if (touched.length === 0) {
      patchClaim({ singleMinistry: true, claimMinistry: adopt.ministry, claimEvent: adopt.event });
      return;
    }
    setModeSwitchPrompt({
      adopt,
      distinct: new Set(
        active.filter((it) => it.ministry).map((it) => JSON.stringify([it.ministry, it.event]))
      ).size,
      unverify: touched.filter((it) => it.isVerified).length,
    });
  }

  async function runSuggest(inputOrValue: HTMLInputElement | null | string) {
    if (!claim || suggesting) return;
    const description = typeof inputOrValue === "string"
      ? inputOrValue.trim()
      : inputOrValue?.value.trim() ?? "";
    if (!description) {
      if (typeof inputOrValue !== "string") {
        inputOrValue?.focus();
      }
      return;
    }
    setSuggesting(true);
    setPendingSuggestion(null);
    try {
      const res = await fetch(`/api/reimbursements/${claim.id}/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description }),
      });
      if (!res.ok) {
        setError((await res.json()).error ?? "Suggestion failed");
        return;
      }
      setError(null);
      const data = await res.json();
      // The route persisted the description as the claim note.
      setClaim((prev) => (prev ? { ...prev, claimDescription: description } : prev));
      setPendingSuggestion(data.suggestion);
    } catch {
      setError("Suggestion failed");
    } finally {
      setSuggesting(false);
    }
  }

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
    if (res.ok) router.push("/");
    else setError((await res.json()).error ?? "Delete failed");
  }

  return (
    <div className="space-y-4">
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

      {error && (
        <div className="card border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}

      {isDraft && (
        <ClaimMinistryPanel
          claim={claim}
          suggesting={suggesting}
          pendingSuggestion={pendingSuggestion}
          onModeSingle={switchToSingle}
          onModeMulti={() => {
            setPendingSuggestion(null);
            patchClaim({ singleMinistry: false });
          }}
          onFanOut={(next) => fanOutClaimPatch(next, "manual")}
          onPersistDescription={(v) => patchClaim({ claimDescription: v })}
          onSuggest={runSuggest}
          onApplySuggestion={(s) => {
            fanOutClaimPatch({ claimMinistry: s.ministry ?? "", claimEvent: s.event ?? "" }, "ai");
          }}
          onDismissSuggestion={() => setPendingSuggestion(null)}
          fanOutUndo={fanOutUndo}
          onUndo={undoFanOut}
        />
      )}

      {/* One card per receipt: the image and its digitized rows travel together
          (rows are 1:1 with receipts; splitting is the only multiplier), so
          there are no independently scrolling columns to keep in sync. */}
      <div className="space-y-4">
        {groups.map((group, gi) => (
          <div key={group.receipt.id} className="card overflow-hidden" data-testid={`group-${group.receipt.id}`}>
            {/* Header carries only the receipt's identity plus its one card-level
                action; image and money controls live next to what they act on. */}
            {claim.receipts.length > 1 && (
              <div className="flex items-center justify-between gap-2 border-b border-stone-100 bg-stone-50 px-4 py-2">
                <span className="min-w-0 text-sm font-semibold text-stone-700">
                  Receipt {gi + 1}: {receiptLabel(group.receipt)}
                  {group.receipt.note && (
                    <span className="ml-1 font-normal text-stone-500">· {group.receipt.note}</span>
                  )}
                </span>
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
              </div>
            )}
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
              {/* The relative wrapper matches the clamped scroll viewport, so the
                  floating edit button stays pinned to the visible part of a
                  tall receipt photo rather than its full scroll height. */}
              <div className="relative border-b border-stone-100 lg:border-b-0 lg:border-r">
                <div className="max-h-[75vh] overflow-y-auto bg-stone-50/50">
                  {/* Keep the PDF arm separate from the image path: a PDF stays a
                      PDF (packet append, "open original", no crop/rotate) — this
                      shows a raster preview inline, it does not reclassify it. */}
                  {group.receipt.mimeType === "application/pdf" ? (
                    <PdfReceiptPreview receiptId={group.receipt.id} />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={fileUrl(group.receipt.id)}
                      alt={group.receipt.originalName}
                      className="w-full"
                    />
                  )}
                </div>
                {isDraft && group.receipt.mimeType !== "application/pdf" && (
                  <button
                    className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-stone-900/60 px-4 py-2 text-xs font-semibold text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-stone-900/80"
                    onClick={() => setEditingReceiptId(group.receipt.id)}
                    title="Rotate or crop this receipt photo"
                    data-testid={`edit-image-${group.receipt.id}`}
                  >
                    ✂ Rotate / crop
                  </button>
                )}
              </div>
              {/* Sticky so the fields stay beside a tall receipt photo while it scrolls. */}
              <div className="lg:sticky lg:top-20 lg:self-start">
                {claim.receipts.length === 1 && group.receipt.note && (
                  <div
                    className="border-b border-stone-100 bg-stone-50 px-4 py-2 text-xs text-stone-500"
                    data-testid={`receipt-note-display-${group.receipt.id}`}
                  >
                    Note: <span className="font-medium text-stone-700">{group.receipt.note}</span>
                  </div>
                )}
                {isDraft && needsManualEntry(group.items) && (
                  <div
                    className="flex items-center justify-between gap-2 border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-900"
                    data-testid={`manual-entry-banner-${group.receipt.id}`}
                  >
                    <span>⚠ The AI couldn&apos;t read this receipt.</span>
                    <button
                      className="whitespace-nowrap rounded bg-amber-600 px-2 py-1 font-semibold text-white hover:bg-amber-700"
                      onClick={() => setManualEntryReceiptId(group.receipt.id)}
                      data-testid={`manual-entry-open-${group.receipt.id}`}
                    >
                      Enter details
                    </button>
                  </div>
                )}
                <ul className="divide-y divide-stone-100">
                  {group.items.map((item, idx) => (
                    <LineItemRow
                      key={item.id}
                      item={item}
                      readOnly={!isDraft}
                      singleMode={claim.singleMinistry && claim.receipts.length > 1}
                      nudged={item.id === nudgedItemId}
                      onPatch={patchItem}
                      onSplit={() =>
                        claim.singleMinistry && claim.receipts.length > 1
                          ? setSplitModeItem(item)
                          : setSplitItem(item)
                      }
                      canMergeUp={idx > 0}
                      mergeUpBlocked={idx > 0 && group.items[idx - 1].isExcluded}
                      onMergeUp={() => mergeUp(item.id)}
                    />
                  ))}
                </ul>
                {/* Receipt-style total line directly under the amounts it sums.
                    Kept as one text run — e2e matches getByText("Subtotal: $…"). */}
                <div
                  className="border-t border-stone-200 bg-stone-50 px-4 py-2 text-right"
                  data-testid={`subtotal-${group.receipt.id}`}
                >
                  <span className="text-sm text-stone-500">Subtotal:</span>{" "}
                  <span
                    className="text-sm font-bold text-stone-800"
                    {...(claim.receipts.length === 1 ? { "data-testid": "claim-total" } : {})}
                  >
                    {formatCents(subtotalCents(group.items))}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}

        {claim.receipts.length > 1 && (
          <div className="card flex items-center justify-between bg-indigo-50 p-4">
            <span className="font-semibold text-indigo-900">Claim total</span>
            <span className="text-xl font-bold text-indigo-900" data-testid="claim-total">
              {formatCents(claim.totalCents)}
            </span>
          </div>
        )}
      </div>

      {/* Floating action bar: verify progress and the claim actions stay in
          reach while scrolling a long claim. */}
      <div className="card sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-white/95 p-3 shadow-lg backdrop-blur">
        {isDraft && claim.receipts.length > 1 ? (
          <div className="flex min-w-48 flex-1 items-center gap-3" data-testid="verify-progress">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-stone-200">
              <div
                className="h-full rounded-full bg-indigo-600 transition-all"
                style={{
                  width: activeItems.length ? `${(verifiedCount / activeItems.length) * 100}%` : "0%",
                }}
              />
            </div>
            <span className="whitespace-nowrap text-sm font-medium text-stone-600">
              {verifiedCount} / {activeItems.length} verified
            </span>
          </div>
        ) : isDraft ? null : (
          <span className="text-sm text-stone-500">Generated — rows are frozen.</span>
        )}
        <div className="ml-auto flex items-center gap-3">
          {isDraft && (
            <button
              className="btn-secondary"
              onClick={() => setAddingReceipts(true)}
              data-testid="add-receipts"
            >
              ＋ Add receipts
            </button>
          )}
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
          {/* The disabled button drops pointer events so the wrapper catches the
              click and walks the user to the first row still needing a verify.
              The real gate stays server-side in the PDF route. */}
          <span
            onClick={() => {
              if (isDraft && !pdfButtonEnabled && !downloading) nudgeFirstUnverified();
            }}
            title={isDraft && !pdfButtonEnabled ? "Choose a ministry first" : undefined}
          >
            <button
              className="btn-primary disabled:pointer-events-none"
              onClick={generatePdf}
              disabled={!pdfButtonEnabled || downloading}
              data-testid="generate-pdf"
            >
              {downloading ? "Building PDF…" : isDraft ? "⬇ Generate PDF" : "⬇ Download PDF again"}
            </button>
          </span>
        </div>
      </div>

      {addingReceipts && (
        <AddReceiptsDialog
          claimId={claim.id}
          excludeReceiptIds={claim.receipts.map((ref) => ref.receiptId)}
          onClose={() => setAddingReceipts(false)}
          onAdded={async () => {
            setAddingReceipts(false);
            await load();
          }}
        />
      )}

      {manualEntryReceiptId &&
        (() => {
          const group = groups.find((g) => g.receipt.id === manualEntryReceiptId);
          if (!group) return null;
          return (
            <ManualEntryDialog
              claimId={claim.id}
              receipt={group.receipt}
              imageUrl={fileUrl(group.receipt.id)}
              onSaved={async () => {
                // Mark it handled so the auto-open effect doesn't race the
                // reload and reopen the row we just filled.
                setDeferredManual((prev) => new Set(prev).add(manualEntryReceiptId));
                setManualEntryReceiptId(null);
                await load();
              }}
              onSkip={() => {
                setDeferredManual((prev) => new Set(prev).add(manualEntryReceiptId));
                setManualEntryReceiptId(null);
              }}
            />
          );
        })()}

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

      {/* Split is the multi-ministry mechanism, so in single mode it first
          offers the mode switch instead of silently diverging a row. */}
      {splitModeItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal
          data-testid="split-mode-dialog"
        >
          <div className="card w-full max-w-sm p-6">
            <h2 className="font-bold">Split across ministries?</h2>
            <p className="mt-2 text-sm text-stone-600">
              Splitting divides one receipt between different ministries, but this claim is set to
              use <strong>one ministry</strong> for every row.
            </p>
            <p className="mt-2 text-sm text-stone-600">
              Switch the claim to multiple ministries to split this row.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="btn-secondary"
                onClick={() => setSplitModeItem(null)}
                data-testid="split-mode-cancel"
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                data-testid="split-mode-switch"
                onClick={async () => {
                  const item = splitModeItem;
                  setSplitModeItem(null);
                  await patchClaim({ singleMinistry: false });
                  setSplitItem(item);
                }}
              >
                Switch &amp; split
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Multi → single is the one destructive transition: rows with other
          ministries get overwritten with the adopted value. Spell that out. */}
      {modeSwitchPrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal
          data-testid="mode-switch-dialog"
        >
          <div className="card w-full max-w-md p-6">
            <h2 className="font-bold">Use one ministry for the whole claim?</h2>
            <p className="mt-2 text-sm text-stone-600">
              {modeSwitchPrompt.adopt.ministry ? (
                <>
                  Every row will be set to{" "}
                  <strong>
                    {formatMinistryEvent(
                      modeSwitchPrompt.adopt.ministry,
                      modeSwitchPrompt.adopt.event
                    )}
                  </strong>{" "}
                  (what most rows already use
                  {modeSwitchPrompt.distinct > 1
                    ? `, of the ${modeSwitchPrompt.distinct} different ministries currently picked`
                    : ""}
                  ).
                </>
              ) : (
                <>Rows keep no ministry until you pick one at the top.</>
              )}
              {modeSwitchPrompt.unverify > 0 && (
                <>
                  {" "}
                  <span className="font-medium text-amber-700">
                    {modeSwitchPrompt.unverify} verified row
                    {modeSwitchPrompt.unverify === 1 ? "" : "s"} will need re-verifying.
                  </span>
                </>
              )}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="btn-secondary"
                onClick={() => setModeSwitchPrompt(null)}
                data-testid="mode-switch-cancel"
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                data-testid="mode-switch-confirm"
                onClick={() => {
                  const { adopt } = modeSwitchPrompt;
                  setModeSwitchPrompt(null);
                  fanOutClaimPatch({
                    singleMinistry: true,
                    claimMinistry: adopt.ministry,
                    claimEvent: adopt.event,
                  });
                }}
              >
                Switch &amp; apply
              </button>
            </div>
          </div>
        </div>
      )}

      {/* A fan-out can un-verify rows wholesale, so it's always one click to
          take back while the toast is up. */}
      {fanOutUndo && fanOutUndo.source === "manual" && (
        <div
          className="fixed bottom-24 left-1/2 z-30 -translate-x-1/2"
          data-testid="fanout-toast"
        >
          <div className="flex items-center gap-3 rounded-lg bg-stone-900 px-4 py-2 text-sm text-white shadow-xl">
            <span>{fanOutUndo.message}</span>
            <button
              className="font-semibold text-amber-300 hover:text-amber-200"
              onClick={undoFanOut}
              data-testid="fanout-undo"
            >
              Undo
            </button>
            <button
              className="text-stone-400 hover:text-white"
              onClick={() => setFanOutUndo(null)}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Sentinel select value for the free-text ministry escape hatch; never stored.
const OTHER_MINISTRY = "__other__";

/**
 * Claim-level ministry & event controls. In single mode ("most claims are for
 * one thing") the one selector here replaces every per-row selector, and the
 * user can describe the claim in a sentence to get an AI suggestion — which
 * is only ever applied by the human clicking Apply.
 */
function ClaimMinistryPanel({
  claim,
  suggesting,
  pendingSuggestion,
  onModeSingle,
  onModeMulti,
  onFanOut,
  onPersistDescription,
  onSuggest,
  onApplySuggestion,
  onDismissSuggestion,
  fanOutUndo,
  onUndo,
}: {
  claim: Claim;
  suggesting: boolean;
  pendingSuggestion: MinistrySuggestion | null;
  onModeSingle: () => void;
  onModeMulti: () => void;
  onFanOut: (next: { claimMinistry: string; claimEvent: string }) => void;
  onPersistDescription: (value: string) => void;
  onSuggest: (input: HTMLInputElement | null) => void;
  onApplySuggestion: (s: MinistrySuggestion) => void;
  onDismissSuggestion: () => void;
  fanOutUndo: FanOutUndo | null;
  onUndo: () => void;
}) {
  const descRef = useRef<HTMLInputElement | null>(null);
  // Same "Other…" mechanics as the per-row selector: the sentinel stays
  // selected while the custom text box is still empty.
  const [otherPicked, setOtherPicked] = useState(false);
  const showOtherInput =
    otherPicked || (!!claim.claimMinistry && !isKnownMinistry(claim.claimMinistry));
  const single = claim.singleMinistry;

  const modeButton = (active: boolean) =>
    `rounded-md px-3 py-1.5 transition-colors ${
      active ? "bg-indigo-600 font-semibold text-white" : "text-stone-600 hover:bg-stone-100"
    }`;

  return (
    <div className="card space-y-3 p-4" data-testid="claim-ministry-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-stone-700">
          {single ? "Ministry & event for this claim" : "Ministry & event"}
        </span>
        {claim.receipts.length > 1 && (
          <div className="flex rounded-lg border border-stone-200 p-0.5 text-xs">
            <button
              className={modeButton(single)}
              onClick={() => !single && onModeSingle()}
              aria-pressed={single}
              data-testid="claim-mode-single"
            >
              One ministry
            </button>
            <button
              className={modeButton(!single)}
              onClick={() => single && onModeMulti()}
              aria-pressed={!single}
              data-testid="claim-mode-multi"
            >
              Multiple
            </button>
          </div>
        )}
      </div>

      {single ? (
        <>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              ref={descRef}
              key={`claim-desc-${claim.claimDescription}`}
              className="input flex-1"
              defaultValue={claim.claimDescription}
              placeholder='What’s this claim for? e.g. “snacks for the youth retreat”'
              maxLength={300}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== claim.claimDescription) onPersistDescription(v);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSuggest(descRef.current);
              }}
              aria-label="Claim description"
              data-testid="claim-description"
            />
            <button
              className="btn-secondary whitespace-nowrap"
              onClick={() => onSuggest(descRef.current)}
              disabled={suggesting}
              title="Let the AI suggest a ministry & event from your description — you still apply it"
              data-testid="suggest-ministry"
            >
              {suggesting ? "Thinking…" : "✨ Suggest"}
            </button>
          </div>

          {pendingSuggestion && (
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900"
              data-testid="suggestion-banner"
            >
              {pendingSuggestion.ministry ? (
                (() => {
                  const isApplied = fanOutUndo?.source === "ai";
                  return (
                    <>
                      <span>
                        {isApplied ? "Applied: " : "Suggested: "}
                        <strong>
                          {formatMinistryEvent(
                            pendingSuggestion.ministry,
                            pendingSuggestion.event ?? ""
                          )}
                        </strong>
                      </span>
                      {pendingSuggestion.rationale && (
                        <span className="text-xs text-violet-700">{pendingSuggestion.rationale}</span>
                      )}
                      <span className="ml-auto flex items-center gap-2">
                        {isApplied ? (
                          <button
                            className="rounded-full bg-stone-600 px-3 py-1 text-xs font-semibold text-white hover:bg-stone-700"
                            onClick={onUndo}
                            data-testid="suggestion-undo"
                          >
                            Undo
                          </button>
                        ) : (
                          <>
                            <button
                              className="rounded-full bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-700"
                              onClick={() => onApplySuggestion(pendingSuggestion)}
                              data-testid="suggestion-apply"
                            >
                              {claim.receipts.length === 1 ? "Apply" : "Apply to all rows"}
                            </button>
                            <button
                              className="text-xs text-violet-700 hover:underline"
                              onClick={onDismissSuggestion}
                              data-testid="suggestion-dismiss"
                            >
                              Dismiss
                            </button>
                          </>
                        )}
                      </span>
                    </>
                  );
                })()
              ) : (
                <>
                  <span>No confident match — pick a ministry below.</span>
                  {pendingSuggestion.rationale && (
                    <span className="text-xs text-violet-700">{pendingSuggestion.rationale}</span>
                  )}
                  <button
                    className="ml-auto text-xs text-violet-700 hover:underline"
                    onClick={onDismissSuggestion}
                    data-testid="suggestion-dismiss"
                  >
                    Dismiss
                  </button>
                </>
              )}
            </div>
          )}

          {/* Each field sits in a width-controlling wrapper rather than a `w-*`
              class on the input itself — `.input`'s `@apply w-full` otherwise
              wins the cascade over a same-element width utility regardless of
              class order (see CONVENTIONS.md). Stacked on mobile (each
              wrapper is a plain block, full width); side by side from `sm:`
              up, with the ministry select taking the remaining room. */}
          {claim.receipts.length > 1 && (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <div className="sm:w-72 sm:flex-none">
                <select
                  className="input"
                  value={showOtherInput ? OTHER_MINISTRY : claim.claimMinistry}
                  onChange={(e) => {
                    if (e.target.value === OTHER_MINISTRY) {
                      setOtherPicked(true);
                      // Clear the stored category (and the rows mirroring it) so
                      // the verify gate stays honest until custom text is typed.
                      if (claim.claimMinistry)
                        onFanOut({ claimMinistry: "", claimEvent: claim.claimEvent });
                    } else {
                      setOtherPicked(false);
                      onFanOut({ claimMinistry: e.target.value, claimEvent: claim.claimEvent });
                    }
                  }}
                  aria-label="Claim ministry"
                  data-testid="claim-ministry"
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
              </div>
              {showOtherInput && (
                <div className="sm:w-48 sm:flex-none">
                  <input
                    key={`claim-other-${claim.claimMinistry}`}
                    className="input"
                    defaultValue={isKnownMinistry(claim.claimMinistry) ? "" : claim.claimMinistry}
                    placeholder="Custom ministry"
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== claim.claimMinistry)
                        onFanOut({ claimMinistry: v, claimEvent: claim.claimEvent });
                    }}
                    aria-label="Custom claim ministry"
                    data-testid="claim-ministry-other"
                  />
                </div>
              )}
              <div className="sm:min-w-48 sm:flex-1">
                <input
                  key={`claim-event-${claim.claimEvent}`}
                  className="input"
                  defaultValue={claim.claimEvent}
                  placeholder="Event (optional)"
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v !== claim.claimEvent)
                      onFanOut({ claimMinistry: claim.claimMinistry, claimEvent: v });
                  }}
                  aria-label="Claim event"
                  data-testid="claim-event"
                />
              </div>
              <p className="text-xs text-stone-500 sm:basis-full">
                Applied to every row — you still confirm each amount below.
              </p>
            </div>
          )}
        </>
      ) : (
        <p className="text-xs text-stone-500">
          Each row picks its own ministry below. Switch to “One ministry” to set them all at once.
        </p>
      )}
    </div>
  );
}

function LineItemRow({
  item,
  readOnly,
  singleMode,
  nudged,
  onPatch,
  onSplit,
  canMergeUp,
  mergeUpBlocked,
  onMergeUp,
}: {
  item: LineItem;
  readOnly: boolean;
  singleMode: boolean;
  nudged: boolean;
  onPatch: (id: string, patch: Partial<LineItem>) => Promise<void>;
  onSplit: () => void;
  canMergeUp: boolean;
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
            placeholder="Describe what was purchased"
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
          {singleMode ? (
            // The ministry is set once for the whole claim; the badge shows
            // this row's actual stored value (the PDF's source of truth).
            <span
              className={`inline-flex max-w-full items-center truncate rounded-full px-3 py-1 text-xs ${
                item.ministry ? "bg-stone-100 text-stone-600" : "bg-amber-50 text-amber-700"
              }`}
              title="Ministry applies claim-wide — set it at the top"
              data-testid={`row-ministry-badge-${item.id}`}
            >
              {item.ministry
                ? formatMinistryEvent(item.ministry, item.event)
                : "Ministry set above ↑"}
            </span>
          ) : (
            <>
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
            </>
          )}
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
              <span className="ml-auto flex items-center gap-2">
                {nudged && (
                  <span className="animate-pulse text-xs font-medium text-emerald-700">
                    {item.ministry
                      ? "Click to verify →"
                      : singleMode
                        ? "Set the ministry at the top, then verify →"
                        : "Pick a ministry, then verify →"}
                  </span>
                )}
                <button
                  className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
                    item.isVerified
                      ? "border border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-100"
                      : "bg-emerald-600 text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
                  } ${nudged ? "nudge-ring" : ""}`}
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
              </span>
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
          <button className="btn-secondary" onClick={onClose} disabled={busy} data-testid="split-cancel">
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
