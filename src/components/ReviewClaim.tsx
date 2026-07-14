"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
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
import EsignPanel, { SubmitDialog } from "@/components/esign/EsignPanel";
import { loadEnv, type EsignEnv } from "@/lib/esign/client";
import { useApiErrorMessage } from "@/lib/use-api-error";

/** Statuses in which the packet is under signature — the stored bytes are
 *  frozen, downloads must NOT regenerate, and only paid blocks revert. */
const SIGNED_STATUSES = ["submitted", "rejected", "approved", "paid"] as const;
// Chip labels live in Common.status; the review chip shows draft as "Draft".
const STATUS_STYLES: Record<string, string> = {
  draft: "bg-amber-100 text-amber-800",
  generated: "bg-emerald-100 text-emerald-800",
  submitted: "bg-sky-100 text-sky-800",
  rejected: "bg-red-100 text-red-800",
  approved: "bg-emerald-100 text-emerald-800",
  paid: "bg-indigo-100 text-indigo-800",
};
const STATUS_KEYS = ["generated", "submitted", "rejected", "approved", "paid"] as const;

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
  status: "draft" | "generated" | "submitted" | "rejected" | "approved" | "paid";
  totalCents: number;
  // E-sign mirror fields (docs/ESIGN_DESIGN.md §9.1); null pre-submission.
  approverUserId: string | null;
  signatureLedgerId: string | null;
  signatureLedgerKey: string | null;
  packetSha256: string | null;
  submitSeq: number;
  checkNumber: string;
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

/** A resolved candidate from the suggest route — `ministry` is always real. */
type Candidate = { ministry: string; event: string | null; rationale: string };

/** Extra detail for the terminal follow-up after "Something else…". */
type Refine = { more: string; rejected: string[] };

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
  const t = useTranslations("Review");
  const tStatus = useTranslations("Common.status");
  const apiError = useApiErrorMessage();
  const tCommon = useTranslations("Common");
  const router = useRouter();
  const [claim, setClaim] = useState<Claim | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [splitItem, setSplitItem] = useState<LineItem | null>(null);
  const [downloading, setDownloading] = useState(false);
  // E-sign availability drives whether the action bar offers a "Submit for
  // approval" primary alongside the download. Off ⇒ the bar is the classic
  // single-button print flow, untouched. Null while the master switch loads.
  const [esignEnv, setEsignEnv] = useState<EsignEnv | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
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
  // Single-ministry mode state: the AI's ranked candidates (never applied
  // until the user taps one), whether we're on the terminal follow-up turn
  // (escape hatch becomes "pick manually"), the candidate just applied (drives
  // the applied+undo banner), the multi→single confirm dialog, the undo toast
  // for the last fan-out, and the split-needs-multi-mode gate.
  // `aiCandidates === null` means "not asked yet"; `[]` means "asked, no match".
  const [aiCandidates, setAiCandidates] = useState<Candidate[] | null>(null);
  const [aiFinal, setAiFinal] = useState(false);
  const [appliedSuggestion, setAppliedSuggestion] = useState<Candidate | null>(null);
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
      setError(apiError(await res.json().catch(() => null), t("loadFailed")));
      return;
    }
    setClaim((await res.json()).reimbursement);
  }, [apiError, claimId, t]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    void loadEnv().then(setEsignEnv).catch(() => {});
  }, []);

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
      // Clear active AI suggestion and undo toast if user interacts with a row
      setFanOutUndo((prev) => {
        if (prev?.source === "ai") {
          setAiCandidates(null);
          setAppliedSuggestion(null);
          setAiFinal(false);
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
            setError(apiError(await res.json().catch(() => null), t("updateFailed")));
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
          setError(t("updateFailed"));
        }
      });
    },
    [apiError, enqueue, load, t]
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
            setError(apiError(await res.json().catch(() => null), t("updateFailed")));
            await load();
            return;
          }
          setClaim((await res.json()).reimbursement);
        } catch {
          setError(t("updateFailed"));
        }
      });
    },
    [apiError, claimId, enqueue, load, t]
  );

  const mergeUp = useCallback(
    (itemId: string) =>
      enqueue(async () => {
        try {
          const res = await fetch(`/api/line-items/${itemId}/merge`, { method: "POST" });
          if (!res.ok) {
            setError(apiError(await res.json().catch(() => null), t("mergeFailed")));
            return;
          }
          await load();
        } catch {
          setError(t("mergeFailed"));
        }
      }),
    [apiError, enqueue, load, t]
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
        {error} — <Link href="/claims" className="underline">{t("backToClaims")}</Link>
      </div>
    );
  }
  if (!claim) return <p className="text-sm text-stone-500">{t("loadingClaim")}</p>;

  const activeItems = claim.lineItems.filter((it) => !it.isExcluded);
  const verifiedCount = activeItems.filter((it) => it.isVerified).length;
  const allVerified = activeItems.length > 0 && verifiedCount === activeItems.length;
  const isDraft = claim.status === "draft";
  const pdfButtonEnabled = !isDraft || allVerified;
  // E-sign master switch resolved for this user (A5/A8). When on, the action
  // bar's primary in draft/generated becomes "Submit for approval" and the
  // download drops to a secondary; post-submission states stay with <EsignPanel>.
  const esignEnabled =
    !!esignEnv?.bootstrapped && !!esignEnv.enabled && esignEnv.allowed !== false;
  const esignActions =
    esignEnabled && (claim.status === "draft" || claim.status === "generated");
  const isSigned = (SIGNED_STATUSES as readonly string[]).includes(claim.status);
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
        ? t("quotedValue", { value: formatMinistryEvent(next.claimMinistry, next.claimEvent) })
        : t("noMinistry");
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
        message: t("fanOutSet", { label, count: touched.length }),
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

  /**
   * Ask the AI for ranked candidates. First turn passes just the description;
   * the terminal "Something else…" turn also passes `refine` (the user's extra
   * detail + the rejected candidates) — after it, `aiFinal` flips so the pick-
   * list offers "pick manually" instead of another "Something else…".
   */
  async function runSuggest(description: string, refine?: Refine) {
    if (!claim || suggesting) return;
    const desc = description.trim();
    if (!desc) return;
    setSuggesting(true);
    try {
      const res = await fetch(`/api/reimbursements/${claim.id}/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          refine ? { description: desc, more: refine.more, rejected: refine.rejected } : { description: desc }
        ),
      });
      if (!res.ok) {
        setError(apiError(await res.json().catch(() => null), t("suggestionFailed")));
        return;
      }
      setError(null);
      const data = await res.json();
      // The route persisted the description as the claim note.
      setClaim((prev) => (prev ? { ...prev, claimDescription: desc } : prev));
      setAppliedSuggestion(null);
      setAiCandidates((data.candidates ?? []) as Candidate[]);
      setAiFinal(!!refine);
    } catch {
      setError(t("suggestionFailed"));
    } finally {
      setSuggesting(false);
    }
  }

  /** Apply a candidate (fan out onto every active row) and show applied+undo. */
  function applyCandidate(c: Candidate) {
    setAppliedSuggestion(c);
    fanOutClaimPatch({ claimMinistry: c.ministry, claimEvent: c.event ?? "" }, "ai");
  }

  /** Undo the applied candidate but keep the pick-list up (Apply reappears). */
  function undoApplied() {
    undoFanOut();
    setAppliedSuggestion(null);
  }

  /** Dismiss the whole AI exchange back to the empty prompt. */
  function dismissAi() {
    setAiCandidates(null);
    setAppliedSuggestion(null);
    setAiFinal(false);
  }

  async function generatePdf() {
    setDownloading(true);
    setError(null);
    try {
      // Under signature the packet is frozen (hash-bound) — download the
      // archived bytes; regenerating would 409 and would change the hash.
      const signed = (SIGNED_STATUSES as readonly string[]).includes(claim!.status);
      const res = signed
        ? await fetch(`/api/reimbursements/${claim!.id}/packet`)
        : await fetch(`/api/reimbursements/${claim!.id}/pdf`, { method: "POST" });
      if (!res.ok) throw new Error(apiError(await res.json().catch(() => null), t("pdfFailed")));
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
      setError(e instanceof Error ? e.message : t("pdfFailed"));
    } finally {
      setDownloading(false);
    }
  }

  // Freeze the packet without streaming a download. Generation and file
  // delivery used to be one gesture (POST /pdf returns an attachment); the
  // e-sign path only needs the state transition (draft → generated), so we
  // discard the bytes — the submit ceremony re-fetches the archived packet.
  async function freezePacketForSignature(): Promise<boolean> {
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reimbursements/${claim!.id}/pdf`, { method: "POST" });
      if (!res.ok) throw new Error(apiError(await res.json().catch(() => null), t("pdfFailed")));
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("pdfFailed"));
      return false;
    } finally {
      setDownloading(false);
    }
  }

  // Bar primary for e-sign users. From a verified draft this freezes first
  // (no forced download), then opens the ceremony; from `generated` it opens
  // straight away.
  async function openSubmitForApproval() {
    if (claim!.status === "draft") {
      if (!(await freezePacketForSignature())) return;
    }
    setSubmitOpen(true);
  }

  async function revertClaim() {
    const underSignature = (SIGNED_STATUSES as readonly string[]).includes(claim!.status);
    if (
      !confirm(underSignature ? t("revertConfirmSigned") : t("revertConfirm"))
    )
      return;
    const res = await fetch(`/api/reimbursements/${claim!.id}/revert`, { method: "POST" });
    if (!res.ok) setError(apiError(await res.json().catch(() => null), t("revertFailed")));
    await load();
  }

  async function removeReceipt(receiptId: string) {
    if (
      !confirm(t("removeConfirm"))
    )
      return;
    const res = await fetch(`/api/reimbursements/${claim!.id}/receipts/${receiptId}`, {
      method: "DELETE",
    });
    if (!res.ok) setError(apiError(await res.json().catch(() => null), t("removeFailed")));
    await load();
  }

  async function deleteClaim() {
    if (!confirm(t("discardConfirm"))) return;
    const res = await fetch(`/api/reimbursements/${claim!.id}`, { method: "DELETE" });
    if (res.ok) router.push("/");
    else setError(apiError(await res.json().catch(() => null), t("deleteFailed")));
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">
          {t("title")}{" "}
          <span
            className={`ml-1 align-middle rounded-full px-3 py-1 text-xs font-semibold ${
              STATUS_STYLES[claim.status] ?? STATUS_STYLES.generated
            }`}
            data-testid="claim-status"
          >
            {isDraft
              ? tStatus("draft")
              : tStatus(STATUS_KEYS.find((k) => k === claim.status) ?? "generated")}
          </span>
        </h1>
        <p className="text-sm text-stone-500">{t("instruction")}</p>
      </div>

      {error && (
        <div className="card border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}

      {/* The post-submission panel (verify banner, reject/resubmit, certificate).
          `generated`'s submit-for-approval CTA now lives in the action bar, so
          this only renders once the packet is actually under signature. */}
      {(SIGNED_STATUSES as readonly string[]).includes(claim.status) && (
        <EsignPanel
          claim={{
            id: claim.id,
            status: claim.status,
            ownerUid: "", // owner view — filled server-side checks apply
            approverUserId: claim.approverUserId,
            signatureLedgerId: claim.signatureLedgerId,
            signatureLedgerKey: claim.signatureLedgerKey,
            packetSha256: claim.packetSha256,
            submitSeq: claim.submitSeq,
            totalCents: claim.totalCents,
            checkNumber: claim.checkNumber,
          }}
          onChanged={load}
        />
      )}

      {isDraft && (
        <ClaimMinistryPanel
          claim={claim}
          suggesting={suggesting}
          candidates={aiCandidates}
          aiFinal={aiFinal}
          applied={appliedSuggestion}
          onModeSingle={switchToSingle}
          onModeMulti={() => {
            dismissAi();
            patchClaim({ singleMinistry: false });
          }}
          onFanOut={(next) => fanOutClaimPatch(next, "manual")}
          onPersistDescription={(v) => patchClaim({ claimDescription: v })}
          onSuggest={runSuggest}
          onApplyCandidate={applyCandidate}
          onDismiss={dismissAi}
          onUndo={undoApplied}
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
                  {t("receiptHeader", { index: gi + 1, label: receiptLabel(group.receipt) })}
                  {group.receipt.note && (
                    <span className="ml-1 font-normal text-stone-500">{t("headerNote", { note: group.receipt.note })}</span>
                  )}
                </span>
                {isDraft && (
                  <button
                    className="whitespace-nowrap rounded px-2 py-1 text-xs text-stone-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                    disabled={claim.receipts.length === 1}
                    title={
                      claim.receipts.length === 1 ? t("removeDisabledTitle") : t("removeTitle")
                    }
                    onClick={() => removeReceipt(group.receipt.id)}
                    data-testid={`remove-receipt-${group.receipt.id}`}
                  >
                    {t("removeButton")}
                  </button>
                )}
              </div>
            )}
            {(group.receipt.extractedRefundCents ?? 0) > 0 && (
              <div
                className="border-b border-stone-100 bg-amber-50 px-4 py-2 text-xs text-amber-900"
                data-testid={`derivation-${group.receipt.id}`}
              >
                {t("derivation", {
                  charged: formatCents(group.receipt.extractedTotalCents ?? 0),
                  refunded: formatCents(group.receipt.extractedRefundCents!),
                  suggested: formatCents(
                    (group.receipt.extractedTotalCents ?? 0) - group.receipt.extractedRefundCents!
                  ),
                })}
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
                    title={t("editPhotoTitle")}
                    data-testid={`edit-image-${group.receipt.id}`}
                  >
                    {t("editPhotoButton")}
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
                    {t.rich("receiptNote", {
                      note: group.receipt.note,
                      strong: (chunks) => <span className="font-medium text-stone-700">{chunks}</span>,
                    })}
                  </div>
                )}
                {isDraft && needsManualEntry(group.items) && (
                  <div
                    className="flex items-center justify-between gap-2 border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-900"
                    data-testid={`manual-entry-banner-${group.receipt.id}`}
                  >
                    <span>{t("aiFailed")}</span>
                    <button
                      className="whitespace-nowrap rounded bg-amber-600 px-2 py-1 font-semibold text-white hover:bg-amber-700"
                      onClick={() => setManualEntryReceiptId(group.receipt.id)}
                      data-testid={`manual-entry-open-${group.receipt.id}`}
                    >
                      {t("enterDetails")}
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
                  <span className="text-sm text-stone-500">{t("subtotal")}</span>{" "}
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
            <span className="font-semibold text-indigo-900">{t("claimTotal")}</span>
            <span className="text-xl font-bold text-indigo-900" data-testid="claim-total">
              {formatCents(claim.totalCents)}
            </span>
          </div>
        )}
      </div>

      {/* Floating action bar: verify progress and the claim actions stay in
          reach while scrolling a long claim. One structure for every case —
          edit utilities (soft-red Discard, Add receipts) on the left, the
          finish action(s) behind a divider on the right — so the e-sign-on
          and e-sign-off bars read the same. E-sign just adds a second finish
          button (E-sign primary) beside Print. Terse + one row on mobile. */}
      <div className="card sticky bottom-4 z-20 flex flex-col gap-3 bg-white/95 p-3 shadow-lg backdrop-blur sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-4 sm:gap-y-2">
        {isDraft && claim.receipts.length > 1 ? (
          <div
            className="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:min-w-48 sm:flex-1"
            data-testid="verify-progress"
          >
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-stone-200">
              <div
                className="h-full rounded-full bg-indigo-600 transition-all"
                style={{
                  width: activeItems.length ? `${(verifiedCount / activeItems.length) * 100}%` : "0%",
                }}
              />
            </div>
            <span className="whitespace-nowrap text-sm font-medium text-stone-600">
              {t("verifiedProgress", { verified: verifiedCount, total: activeItems.length })}
            </span>
          </div>
        ) : isDraft ? (
          // Single-receipt e-sign draft has no progress bar; a one-line hint
          // fills what would otherwise be an empty left gutter and carries the
          // print-vs-sign guidance (only meaningful when there's a fork —
          // hidden on mobile, where the labeled buttons already make it clear).
          esignActions ? (
            <span className="hidden text-sm text-stone-500 sm:block sm:flex-1">
              {t("esignFinishHint")}
            </span>
          ) : null
        ) : (
          <span className="text-sm text-stone-500">
            {claim.status === "generated" ? t("generatedFrozen") : t("underSignatureFrozen")}
          </span>
        )}
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto sm:gap-3">
          {/* Edit utilities. Destructive Discard is a soft-red ✕ pulled to the
              far left, away from the finish actions; Add receipts is "+ Receipt".
              Both spell out on desktop. Compact mobile padding (px-3) keeps
              everything on a single row down to ~360px. */}
          {isDraft && (
            <button
              className="btn-soft-danger !px-3 sm:!px-4"
              onClick={deleteClaim}
              aria-label={t("discard")}
              data-testid="discard-claim"
            >
              <span className="sm:hidden" aria-hidden>
                ✕
              </span>
              <span className="hidden sm:inline">{t("discard")}</span>
            </button>
          )}
          {isDraft && (
            <button
              className="btn-secondary !px-3 sm:!px-4"
              onClick={() => setAddingReceipts(true)}
              data-testid="add-receipts"
            >
              <span className="sm:hidden">{t("addReceiptShort")}</span>
              <span className="hidden sm:inline">{t("addReceipts")}</span>
            </button>
          )}
          {!isDraft && claim.status !== "paid" && (
            <button
              className="btn-secondary !px-3 sm:!px-4"
              onClick={revertClaim}
              data-testid="revert-claim"
            >
              {t("revert")}
            </button>
          )}
          {/* Finish group behind a divider. Print is the paper path — the sole
              primary when e-sign is off, a secondary when E-sign is offered.
              Each button is gated the same way: a click while rows are
              unverified nudges the first one; the real gate stays server-side. */}
          <div className="flex items-center gap-2 sm:gap-3 sm:border-l sm:border-stone-200 sm:pl-3">
            <span
              onClick={() => {
                if (isDraft && !pdfButtonEnabled && !downloading) nudgeFirstUnverified();
              }}
              title={isDraft && !pdfButtonEnabled ? t("chooseMinistryFirst") : undefined}
            >
              <button
                className={`${esignActions ? "btn-secondary" : "btn-primary"} !px-3 disabled:pointer-events-none sm:!px-4`}
                onClick={generatePdf}
                disabled={!pdfButtonEnabled || downloading}
                data-testid={esignActions ? "download-pdf" : "generate-pdf"}
              >
                {downloading ? t("buildingPdf") : isSigned ? t("downloadSigned") : t("printAction")}
              </button>
            </span>
            {esignActions && (
              <span
                onClick={() => {
                  if (isDraft && !pdfButtonEnabled && !downloading) nudgeFirstUnverified();
                }}
                title={isDraft && !pdfButtonEnabled ? t("chooseMinistryFirst") : undefined}
              >
                <button
                  className="btn-primary !px-3 disabled:pointer-events-none sm:!px-4"
                  onClick={openSubmitForApproval}
                  disabled={!pdfButtonEnabled || downloading}
                  data-testid="submit-for-approval"
                >
                  {downloading ? t("buildingPdf") : t("esignAction")}
                </button>
              </span>
            )}
          </div>
        </div>
      </div>

      {submitOpen && esignEnv && (
        <SubmitDialog
          claim={{
            id: claim.id,
            status: claim.status,
            ownerUid: esignEnv.me.userId,
            approverUserId: claim.approverUserId,
            signatureLedgerId: claim.signatureLedgerId,
            signatureLedgerKey: claim.signatureLedgerKey,
            packetSha256: claim.packetSha256,
            submitSeq: claim.submitSeq,
            totalCents: claim.totalCents,
            checkNumber: claim.checkNumber,
          }}
          env={esignEnv}
          onClose={() => setSubmitOpen(false)}
          onDone={async () => {
            setSubmitOpen(false);
            await load();
          }}
        />
      )}

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
            <h2 className="font-bold">{t("splitModeTitle")}</h2>
            <p className="mt-2 text-sm text-stone-600">
              {t.rich("splitModeBody", { strong: (chunks) => <strong>{chunks}</strong> })}
            </p>
            <p className="mt-2 text-sm text-stone-600">{t("splitModeBody2")}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="btn-secondary"
                onClick={() => setSplitModeItem(null)}
                data-testid="split-mode-cancel"
              >
                {tCommon("cancel")}
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
                {t("switchAndSplit")}
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
            <h2 className="font-bold">{t("modeSwitchTitle")}</h2>
            <p className="mt-2 text-sm text-stone-600">
              {modeSwitchPrompt.adopt.ministry
                ? t.rich("modeSwitchBody", {
                    value: formatMinistryEvent(
                      modeSwitchPrompt.adopt.ministry,
                      modeSwitchPrompt.adopt.event
                    ),
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })
                : t("modeSwitchBodyNoMinistry")}
              {modeSwitchPrompt.unverify > 0 && (
                <>
                  {" "}
                  <span className="font-medium text-amber-700">
                    {t("modeSwitchUnverify", { count: modeSwitchPrompt.unverify })}
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
                {tCommon("cancel")}
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
                {t("switchAndApply")}
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
              {t("undo")}
            </button>
            <button
              className="text-stone-400 hover:text-white"
              onClick={() => setFanOutUndo(null)}
              aria-label={t("dismissAria")}
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
 * AI zone lets the user describe the claim to get up to three ranked
 * candidates — tapping one applies it (no further model call); only
 * "Something else…" spends the one terminal follow-up. The AI only ever
 * suggests; the human applies.
 */
function ClaimMinistryPanel({
  claim,
  suggesting,
  candidates,
  aiFinal,
  applied,
  onModeSingle,
  onModeMulti,
  onFanOut,
  onPersistDescription,
  onSuggest,
  onApplyCandidate,
  onDismiss,
  onUndo,
}: {
  claim: Claim;
  suggesting: boolean;
  candidates: Candidate[] | null;
  aiFinal: boolean;
  applied: Candidate | null;
  onModeSingle: () => void;
  onModeMulti: () => void;
  onFanOut: (next: { claimMinistry: string; claimEvent: string }) => void;
  onPersistDescription: (value: string) => void;
  onSuggest: (description: string, refine?: Refine) => void;
  onApplyCandidate: (c: Candidate) => void;
  onDismiss: () => void;
  onUndo: () => void;
}) {
  const t = useTranslations("Review");
  const descRef = useRef<HTMLTextAreaElement | null>(null);
  const followupRef = useRef<HTMLTextAreaElement | null>(null);
  // "Something else…" reveals a second prompt for the one terminal follow-up.
  const [followupOpen, setFollowupOpen] = useState(false);
  // A fresh candidate set closes any open follow-up box.
  useEffect(() => {
    setFollowupOpen(false);
  }, [candidates]);
  // Same "Other…" mechanics as the per-row selector: the sentinel stays
  // selected while the custom text box is still empty.
  const [otherPicked, setOtherPicked] = useState(false);
  const showOtherInput =
    otherPicked || (!!claim.claimMinistry && !isKnownMinistry(claim.claimMinistry));
  const single = claim.singleMinistry;
  const sendMore = () => {
    const more = followupRef.current?.value.trim();
    if (more && candidates) onSuggest(claim.claimDescription, { more, rejected: candidates.map((c) => c.ministry) });
  };

  const modeButton = (active: boolean) =>
    `rounded-md px-3 py-1.5 transition-colors ${
      active ? "bg-indigo-600 font-semibold text-white" : "text-stone-600 hover:bg-stone-100"
    }`;

  return (
    <div className="card space-y-3 p-4" data-testid="claim-ministry-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-stone-700">
          {single ? t("panelTitleSingle") : t("panelTitle")}
        </span>
        {claim.receipts.length > 1 && (
          <div className="flex rounded-lg border border-stone-200 p-0.5 text-xs">
            <button
              className={modeButton(single)}
              onClick={() => !single && onModeSingle()}
              aria-pressed={single}
              data-testid="claim-mode-single"
            >
              {t("modeOne")}
            </button>
            <button
              className={modeButton(!single)}
              onClick={() => single && onModeMulti()}
              aria-pressed={!single}
              data-testid="claim-mode-multi"
            >
              {t("modeMultiple")}
            </button>
          </div>
        )}
      </div>

      {single ? (
        <>
          {/* AI zone: a distinct violet "surface" so it reads as assistive, not
              one more form field. Describe → up to 3 ranked candidates → tap one
              to apply (no further call); "Something else…" spends the single
              terminal follow-up, after which the escape hatch is "pick manually". */}
          <div
            className="rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-3"
            data-testid="ai-zone"
          >
            <div className="mb-2 flex items-center gap-2">
              <span aria-hidden className="text-sm">✨</span>
              <span className="text-xs font-bold uppercase tracking-wide text-violet-700">
                {t("aiTitle")}
              </span>
              <span className="ml-auto text-[11px] font-medium text-violet-400">{t("aiOptional")}</span>
            </div>

            {applied ? (
              <div
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900"
                data-testid="suggestion-banner"
              >
                <span>
                  {t.rich("suggestionApplied", {
                    value: formatMinistryEvent(applied.ministry, applied.event ?? ""),
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </span>
                <button
                  className="ml-auto rounded-full bg-stone-600 px-3 py-1 text-xs font-semibold text-white hover:bg-stone-700"
                  onClick={onUndo}
                  data-testid="suggestion-undo"
                >
                  {t("undo")}
                </button>
              </div>
            ) : suggesting ? (
              <div className="flex items-center gap-3 px-1 py-2" data-testid="ai-thinking">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-500 text-xs text-white">
                  ✨
                </span>
                <div className="flex flex-1 flex-col gap-1.5">
                  <div className="h-2 animate-pulse rounded bg-violet-200" />
                  <div className="h-2 w-3/5 animate-pulse rounded bg-violet-200" />
                </div>
                <span className="text-xs text-violet-500">{t("thinking")}</span>
              </div>
            ) : candidates === null ? (
              <>
                <p className="mb-2 text-xs text-violet-800/80">{t("aiSub")}</p>
                <div className="rounded-lg border border-violet-200 bg-white p-2">
                  <textarea
                    ref={descRef}
                    key={`claim-desc-${claim.claimDescription}`}
                    rows={2}
                    className="field-sizing-content w-full resize-y bg-transparent px-1 py-0.5 text-base outline-none md:text-sm"
                    defaultValue={claim.claimDescription}
                    placeholder={t("descPlaceholder")}
                    maxLength={300}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== claim.claimDescription) onPersistDescription(v);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        onSuggest(descRef.current?.value ?? "");
                      }
                    }}
                    aria-label={t("descAria")}
                    data-testid="claim-description"
                  />
                  <div className="mt-1 flex items-center justify-end">
                    <button
                      className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:from-violet-700 hover:to-indigo-700 disabled:opacity-50"
                      onClick={() => onSuggest(descRef.current?.value ?? "")}
                      disabled={suggesting}
                      title={t("suggestTitle")}
                      data-testid="suggest-ministry"
                    >
                      {t("send")} <span aria-hidden>➤</span>
                    </button>
                  </div>
                </div>
              </>
            ) : candidates.length === 0 ? (
              <div
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900"
                data-testid="suggestion-banner"
              >
                <span>{t("noConfidentMatch")}</span>
                <button
                  className="ml-auto text-xs text-violet-700 hover:underline"
                  onClick={onDismiss}
                  data-testid="suggestion-dismiss"
                >
                  {t("dismiss")}
                </button>
              </div>
            ) : candidates.length === 1 ? (
              <div
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900"
                data-testid="suggestion-banner"
              >
                <span>
                  {t.rich("suggestionSuggested", {
                    value: formatMinistryEvent(candidates[0].ministry, candidates[0].event ?? ""),
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </span>
                {candidates[0].rationale && (
                  <span className="text-xs text-violet-700">{candidates[0].rationale}</span>
                )}
                <span className="ml-auto flex items-center gap-2">
                  <button
                    className="rounded-full bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-700"
                    onClick={() => onApplyCandidate(candidates[0])}
                    data-testid="suggestion-apply"
                  >
                    {claim.receipts.length === 1 ? t("apply") : t("applyAllRows")}
                  </button>
                  <button
                    className="text-xs text-violet-700 hover:underline"
                    onClick={onDismiss}
                    data-testid="suggestion-dismiss"
                  >
                    {t("dismiss")}
                  </button>
                </span>
              </div>
            ) : (
              <div
                className="rounded-lg border border-violet-200 bg-violet-50 p-2 text-sm text-violet-900"
                data-testid="suggestion-banner"
              >
                <p className="px-1 pb-1.5 text-xs font-medium text-violet-800">{t("candidatesLead")}</p>
                <ul className="flex flex-col gap-1.5">
                  {candidates.map((c, i) => (
                    <li key={`${c.ministry}-${i}`}>
                      <button
                        className="flex w-full items-center justify-between gap-2 rounded-lg border border-violet-200 bg-white px-3 py-2 text-left hover:border-violet-300 hover:bg-violet-50"
                        onClick={() => onApplyCandidate(c)}
                        data-testid={`suggestion-candidate-${i}`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-violet-900">
                            {formatMinistryEvent(c.ministry, c.event ?? "")}
                          </span>
                          {c.rationale && (
                            <span className="block truncate text-xs text-violet-500">{c.rationale}</span>
                          )}
                        </span>
                        <span aria-hidden className="text-violet-400">›</span>
                      </button>
                    </li>
                  ))}
                  <li>
                    {aiFinal ? (
                      <button
                        className="w-full rounded-lg border border-dashed border-violet-200 px-3 py-2 text-left text-xs text-violet-500 hover:bg-violet-50"
                        onClick={onDismiss}
                        data-testid="suggestion-dismiss"
                      >
                        {t("pickManuallyEscape")}
                      </button>
                    ) : !followupOpen ? (
                      <button
                        className="w-full rounded-lg border border-dashed border-violet-200 px-3 py-2 text-left text-xs text-violet-500 hover:bg-violet-50"
                        onClick={() => setFollowupOpen(true)}
                        data-testid="suggestion-other"
                      >
                        {t("somethingElse")}
                      </button>
                    ) : (
                      <div className="rounded-lg border border-violet-200 bg-white p-2">
                        <textarea
                          ref={followupRef}
                          rows={2}
                          className="field-sizing-content w-full resize-y bg-transparent px-1 py-0.5 text-base outline-none md:text-sm"
                          placeholder={t("somethingElsePlaceholder")}
                          maxLength={300}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              sendMore();
                            }
                          }}
                          aria-label={t("somethingElseAria")}
                          data-testid="suggestion-followup"
                          autoFocus
                        />
                        <div className="mt-1 flex items-center justify-end">
                          <button
                            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:from-violet-700 hover:to-indigo-700 disabled:opacity-50"
                            onClick={sendMore}
                            disabled={suggesting}
                            data-testid="suggestion-followup-send"
                          >
                            {t("send")} <span aria-hidden>➤</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                </ul>
              </div>
            )}
          </div>

          {/* Each field sits in a width-controlling wrapper rather than a `w-*`
              class on the input itself — `.input`'s `@apply w-full` otherwise
              wins the cascade over a same-element width utility regardless of
              class order (see CONVENTIONS.md). Stacked on mobile (each
              wrapper is a plain block, full width); side by side from `sm:`
              up, with the ministry select taking the remaining room. */}
          {claim.receipts.length > 1 && (
            <>
              {/* The dropdowns are the manual alternative to the AI zone above —
                  labelled so, so a newcomer reads them as the fallback, not a
                  second thing to fill in. */}
              <div className="flex items-center gap-3 py-0.5 text-[11px] font-medium uppercase tracking-wide text-stone-400">
                <span className="h-px flex-1 bg-stone-200" />
                {t("orSetYourself")}
                <span className="h-px flex-1 bg-stone-200" />
              </div>
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
                  aria-label={t("claimMinistryAria")}
                  data-testid="claim-ministry"
                >
                  <option value="">{t("pickMinistry")}</option>
                  {MINISTRY_GROUPS.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                  <option value={OTHER_MINISTRY}>{t("otherOption")}</option>
                </select>
              </div>
              {showOtherInput && (
                <div className="sm:w-48 sm:flex-none">
                  <input
                    key={`claim-other-${claim.claimMinistry}`}
                    className="input"
                    defaultValue={isKnownMinistry(claim.claimMinistry) ? "" : claim.claimMinistry}
                    placeholder={t("customMinistryPlaceholder")}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== claim.claimMinistry)
                        onFanOut({ claimMinistry: v, claimEvent: claim.claimEvent });
                    }}
                    aria-label={t("customClaimMinistryAria")}
                    data-testid="claim-ministry-other"
                  />
                </div>
              )}
              <div className="sm:min-w-48 sm:flex-1">
                <input
                  key={`claim-event-${claim.claimEvent}`}
                  className="input"
                  defaultValue={claim.claimEvent}
                  placeholder={t("eventPlaceholder")}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v !== claim.claimEvent)
                      onFanOut({ claimMinistry: claim.claimMinistry, claimEvent: v });
                  }}
                  aria-label={t("claimEventAria")}
                  data-testid="claim-event"
                />
              </div>
                <p className="text-xs text-stone-500 sm:basis-full">{t("appliedEveryRow")}</p>
              </div>
            </>
          )}
        </>
      ) : (
        <p className="text-xs text-stone-500">{t("multiHint")}</p>
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
  const t = useTranslations("Review");
  const negative = item.amountCents < 0;
  const excluded = item.isExcluded;
  // "Other…" stays selected while the custom text box is still empty; a saved
  // value that isn't in the budget list (custom or legacy) also renders as Other.
  const [otherPicked, setOtherPicked] = useState(false);
  const showOtherInput = otherPicked || (!!item.ministry && !isKnownMinistry(item.ministry));

  return (
    <li
      className={`px-4 py-3 transition-all border-l-4 ${
        excluded
          ? "bg-stone-50 opacity-60 border-transparent"
          : item.isVerified
            ? "bg-emerald-50/20 border-emerald-500"
            : "bg-white border-transparent"
      }`}
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
            placeholder={t("rowDescPlaceholder")}
            disabled={excluded || readOnly}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== item.description) onPatch(item.id, { description: v });
            }}
            aria-label={t("rowDescAria")}
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
              title={t("badgeTitle")}
              data-testid={`row-ministry-badge-${item.id}`}
            >
              {item.ministry
                ? formatMinistryEvent(item.ministry, item.event)
                : t("ministrySetAbove")}
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
                aria-label={t("ministryAria")}
                data-testid={`ministry-${item.id}`}
              >
                <option value="">{t("pickMinistry")}</option>
                {MINISTRY_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </optgroup>
                ))}
                <option value={OTHER_MINISTRY}>{t("otherOption")}</option>
              </select>
              {showOtherInput && (
                <input
                  key={`other-${item.id}-${item.ministry}`}
                  className="input w-44"
                  defaultValue={isKnownMinistry(item.ministry) ? "" : item.ministry}
                  placeholder={t("customMinistryPlaceholder")}
                  disabled={excluded || readOnly}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v !== item.ministry) onPatch(item.id, { ministry: v });
                  }}
                  aria-label={t("customMinistryAria")}
                  data-testid={`ministry-other-${item.id}`}
                />
              )}
              <input
                key={`event-${item.id}-${item.event}`}
                className="input w-40"
                defaultValue={item.event}
                placeholder={t("eventPlaceholder")}
                disabled={excluded || readOnly}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== item.event) onPatch(item.id, { event: v });
                }}
                aria-label={t("eventAria")}
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
              aria-label={t("amountAria")}
              data-testid={`amount-${item.id}`}
            />
          </label>
          {negative && (
            <span className="rounded bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">
              {t("refundBadge")}
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
              title={t("splitRowTitle")}
              data-testid={`split-${item.id}`}
            >
              {t("splitButton")}
            </button>
            {canMergeUp && (
              <button
                className="rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 disabled:opacity-30"
                onClick={onMergeUp}
                disabled={excluded || mergeUpBlocked}
                title={excluded || mergeUpBlocked ? t("mergeBlockedTitle") : t("mergeTitle")}
                data-testid={`merge-${item.id}`}
              >
                {t("mergeButton")}
              </button>
            )}
            <button
              className="rounded px-2 py-1 text-xs text-stone-500 hover:bg-red-50 hover:text-red-600"
              onClick={() => onPatch(item.id, { isExcluded: !excluded, isVerified: false })}
              title={excluded ? t("restoreTitle") : t("excludeTitle")}
              data-testid={`exclude-${item.id}`}
            >
              {excluded ? t("restoreButton") : t("excludeButton")}
            </button>
            {!excluded && (
              <span className="ml-auto flex items-center gap-2">
                {nudged && (
                  <span className="animate-pulse text-xs font-medium text-emerald-700">
                    {item.ministry
                      ? t("nudgeVerify")
                      : singleMode
                        ? t("nudgeSetAbove")
                        : t("nudgePick")}
                  </span>
                )}
                <button
                  className={`flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold border transition-all ${
                    item.isVerified
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-100"
                      : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50 disabled:bg-stone-50 disabled:text-stone-400 disabled:border-stone-200 disabled:cursor-not-allowed"
                  } ${nudged ? "nudge-ring" : ""}`}
                  disabled={!item.isVerified && !item.ministry}
                  title={
                    !item.isVerified && !item.ministry
                      ? t("chooseMinistryFirst")
                      : item.isVerified
                        ? t("verifyTitleVerified")
                        : t("verifyTitle")
                  }
                  onClick={() => onPatch(item.id, { isVerified: !item.isVerified })}
                  aria-pressed={item.isVerified}
                  data-testid={`verify-${item.id}`}
                >
                  <span
                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors ${
                      item.isVerified
                        ? "border-emerald-600 bg-emerald-600 text-white"
                        : (!item.isVerified && !item.ministry)
                          ? "border-stone-200 bg-stone-50"
                          : "border-stone-400 bg-white"
                    }`}
                  >
                    {item.isVerified && "✓"}
                  </span>
                  <span>{t("looksCorrect")}</span>
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
  const t = useTranslations("Review");
  const tCommon = useTranslations("Common");
  const apiError = useApiErrorMessage();
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
      setError(apiError(await res.json().catch(() => null), t("splitFailed")));
      setBusy(false);
      return;
    }
    await onDone();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal>
      <div className="card w-full max-w-sm p-6">
        <h2 className="font-bold">{t("splitDialogTitle")}</h2>
        <p className="mt-1 truncate text-sm text-stone-500">{item.description}</p>
        <p className="text-sm text-stone-500">{t("splitTotal", { amount: formatCents(item.amountCents) })}</p>
        <label className="mt-4 block text-sm font-medium">
          {t("firstPart")}
          <input
            className="input mt-1"
            value={firstText}
            onChange={(e) => setFirstText(e.target.value)}
            autoFocus
            data-testid="split-first-amount"
          />
        </label>
        <p className="mt-2 text-sm text-stone-600">
          {t.rich("secondPart", {
            amount: secondCents !== null ? formatCents(secondCents) : "—",
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
        {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose} disabled={busy} data-testid="split-cancel">
            {tCommon("cancel")}
          </button>
          <button
            className="btn-primary"
            onClick={submit}
            disabled={busy || firstCents === null || firstCents === 0 || secondCents === 0}
            data-testid="split-confirm"
          >
            {t("splitConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
