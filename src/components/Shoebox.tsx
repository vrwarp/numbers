"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useOpenParam } from "@/lib/use-open-param";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import ReceiptImageEditor from "@/components/ReceiptImageEditor";
import ConfirmDialog from "@/components/ConfirmDialog";
import LocaleSwitcher from "./LocaleSwitcher";
import ReceiptViewer from "./ReceiptViewer";
import PdfReceiptPreview from "@/components/PdfReceiptPreview";
import ReceiptGrid, { type ReceiptSummary as Receipt } from "./ReceiptGrid";
import { prepareImageUpload, renderTransformedImage, type ClientTransform } from "@/lib/image-client";
import { readNdjsonStream } from "@/lib/ndjson";
import type { ClaimStreamMessage } from "@/lib/claim-stream";
import { useApiErrorMessage } from "@/lib/use-api-error";

/** A picked image waiting in the prepare step — nothing is uploaded yet.
 *  `edited` holds the client-side rotate/crop render (native resolution);
 *  the upload payload is derived from it (or the file) at Save/Skip time. */
interface LocalPending {
  kind: "local";
  key: number;
  file: File;
  edited: Blob | null;
  previewUrl: string;
}

/** A PDF that was uploaded the moment it was picked: browsers can't thumbnail
 *  a local PDF, so it goes up first and the dialog previews the server-side
 *  raster. Dismissing its dialog only saves the optional note. */
interface UploadedPending {
  kind: "uploaded";
  key: number;
  receipt: Receipt;
}

type PendingItem = LocalPending | UploadedPending;

export default function Shoebox({ searchEnabled }: { searchEnabled?: boolean }) {
  const t = useTranslations("Shoebox");
  const tCommon = useTranslations("Common");
  const tErrors = useTranslations("Errors");
  const apiError = useApiErrorMessage();
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Picked files awaiting the prepare step (describe + optional rotate/crop),
  // front = current. Images upload as their dialog is dismissed, so the
  // full-resolution original never leaves the device — the rotate/crop runs
  // client-side on it and only the downscaled result is sent. PDFs are already
  // uploaded (their dialog shows the server preview and just collects a note).
  const [pending, setPending] = useState<PendingItem[]>([]);
  const pendingKey = useRef(0);
  const [uploadNote, setUploadNote] = useState("");
  const [uploading, setUploading] = useState(false);
  // Live rotate/crop for the photo currently in the prepare step. The editor is
  // embedded in the dialog (no separate modal); the transform is applied when
  // the item uploads on Save. Identity means "upload as shot".
  const [editTransform, setEditTransform] = useState<ClientTransform>({ rotate: 0 });
  // Bumped after a rotate/crop so <img> cache-busts past the file route's max-age.
  const [fileVersions, setFileVersions] = useState<Record<string, number>>({});

  const fileUrl = useCallback(
    (id: string) => `/api/receipts/${id}/file${fileVersions[id] ? `?v=${fileVersions[id]}` : ""}`,
    [fileVersions]
  );
  const [generating, setGenerating] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  // Aborts the in-flight extraction stream when the user bails to manual entry;
  // the ref flag tells the stream's catch that the abort was intentional.
  const generateAbort = useRef<AbortController | null>(null);
  const bailingToManual = useRef(false);
  const [waitCooldownMs, setWaitCooldownMs] = useState(0);
  // Bumped on each quota wait so the countdown ring remounts and restarts.
  const [waitKey, setWaitKey] = useState(0);
  // Shown briefly when the New Claim button is clicked with nothing selected.
  const [showSelectHint, setShowSelectHint] = useState(false);
  const selectHintTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Receipt | null>(null);
  // Receipt id awaiting delete confirmation (the ConfirmDialog is open).
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // Whole-page drag target: true while a file is dragged over the Shoebox.
  const [dragging, setDragging] = useState(false);
  // Depth counter so nested dragenter/dragleave don't flicker the overlay.
  const dragDepth = useRef(0);

  const load = useCallback(async () => {
    const res = await fetch("/api/receipts");
    if (res.ok) setReceipts((await res.json()).receipts);
  }, []);

  useEffect(() => {
    return () => {
      if (selectHintTimeout.current) clearTimeout(selectHintTimeout.current);
    };
  }, []);

  useEffect(() => {
    if (selected.size > 0) setShowSelectHint(false);
  }, [selected]);

  useEffect(() => {
    load();
  }, [load]);

  function onFilesPicked(files: FileList | null) {
    if (!files || files.length === 0) return;
    // Images are NOT uploaded yet: their prepare dialog comes first so any
    // rotate/crop happens client-side on the full-resolution original, and
    // Save/Skip uploads the (downscaled) result. PDFs upload immediately —
    // browsers can't thumbnail a local PDF, so the server-rendered preview
    // needs the file up first (function over purity).
    setError(null);
    setUploadNote("");
    const picked = Array.from(files);
    const images = picked.filter((f) => f.type !== "application/pdf");
    const pdfs = picked.filter((f) => f.type === "application/pdf");
    if (images.length > 0) {
      const items = images.map((file) => ({
        kind: "local" as const,
        key: pendingKey.current++,
        file,
        edited: null,
        previewUrl: URL.createObjectURL(file),
      }));
      setPending((q) => [...q, ...items]);
    }
    if (pdfs.length > 0) void uploadPdfsNow(pdfs);
    if (fileInput.current) fileInput.current.value = "";
  }

  /** Upload picked PDFs right away and queue them for the note-only dialog. */
  async function uploadPdfsNow(files: File[]) {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      const res = await fetch("/api/receipts", { method: "POST", body: form });
      if (!res.ok) throw new Error(apiError(await res.json().catch(() => null), t("uploadFailed")));
      const { receipts: created } = (await res.json()) as { receipts: Receipt[] };
      setPending((q) => [
        ...q,
        ...created.map((receipt) => ({
          kind: "uploaded" as const,
          key: pendingKey.current++,
          receipt,
        })),
      ]);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  // Picked photos exist only in this tab until their dialog is dismissed —
  // warn before a navigation throws them away. (Uploaded PDFs are safe.)
  // Known gap: iOS Safari never fires beforeunload (WebKit policy), so iPhone
  // users get no warning — the modal prepare dialog being open is the only
  // guard there. Don't move real work into this handler.
  const hasLocalPending = pending.some((i) => i.kind === "local");
  useEffect(() => {
    if (!hasLocalPending) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasLocalPending]);

  /** Upload pending images (front item or, for skip-all, all remaining),
   *  downscaled to the server's 1600px cap client-side. Returns whether the
   *  upload succeeded (failures keep the queue so the user can retry). */
  async function uploadPending(items: LocalPending[], note?: string): Promise<boolean> {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      for (const item of items) {
        form.append("files", await prepareImageUpload(item.file, item.edited));
      }
      if (note) form.append("note", note);
      const res = await fetch("/api/receipts", { method: "POST", body: form });
      if (!res.ok) throw new Error(apiError(await res.json().catch(() => null), t("uploadFailed")));
      const done = new Set(items.map((i) => i.key));
      for (const item of items) URL.revokeObjectURL(item.previewUrl);
      setPending((q) => q.filter((i) => !done.has(i.key)));
      setUploadNote("");
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("uploadFailed"));
      return false;
    } finally {
      setUploading(false);
    }
  }

  // Only treat drags that carry files as an upload (ignore text/element drags).
  const dragHasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes("Files");

  function onDragEnter(e: React.DragEvent) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragOver(e: React.DragEvent) {
    if (!dragHasFiles(e)) return;
    // Required so the drop event fires; also marks this a copy operation.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: React.DragEvent) {
    if (!dragHasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDrop(e: React.DragEvent) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    onFilesPicked(e.dataTransfer.files);
  }

  const preparing: PendingItem | null = pending[0] ?? null;

  // Each item gets a fresh crop/rotate; clear the staged transform as the front
  // of the queue advances (the embedded editor remounts and resets alongside).
  useEffect(() => {
    setEditTransform({ rotate: 0 });
  }, [preparing?.key]);

  // Skip-all is the batch escape hatch: dump every queued item as-is (no notes,
  // no crop) so a big pile of receipts doesn't have to be saved one at a time.
  async function skipAllPrepare() {
    if (!preparing) return;
    // Already-uploaded PDFs just leave the queue (their note is skipped) …
    const done = new Set(pending.filter((i) => i.kind === "uploaded").map((i) => i.key));
    if (done.size > 0) {
      setUploadNote("");
      setPending((q) => q.filter((i) => !done.has(i.key)));
    }
    // … while local images upload now, unedited.
    const locals = pending.filter((i): i is LocalPending => i.kind === "local");
    if (locals.length > 0) await uploadPending(locals);
  }

  async function savePrepare() {
    if (!preparing) return;
    const note = uploadNote.trim() || undefined;
    if (preparing.kind === "uploaded") {
      if (note) await saveNote(preparing.receipt.id, note);
      setUploadNote("");
      setPending((q) => q.slice(1));
      return;
    }
    // Local image: bake in any rotate/crop at the photo's native resolution
    // before the (downscaled) upload — the full-res original stays on device.
    let item: LocalPending = preparing;
    if (editTransform.rotate !== 0 || editTransform.crop) {
      setUploading(true);
      setError(null);
      try {
        item = { ...preparing, edited: await renderTransformedImage(preparing.file, editTransform) };
      } catch (e) {
        setError(e instanceof Error ? e.message : t("uploadFailed"));
        setUploading(false);
        return;
      }
    }
    await uploadPending([item], note);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveNote(id: string, note: string) {
    const res = await fetch(`/api/receipts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    });
    if (!res.ok) setError(apiError(await res.json().catch(() => null), t("noteSaveFailed")));
    await load();
  }

  // Deletion confirms through ConfirmDialog, never window.confirm(): iOS
  // suppresses native dialogs in home-screen (standalone) web apps, which made
  // the delete button silently do nothing on installed iPhones.
  function deleteReceipt(id: string) {
    setDeletingId(id);
  }

  async function confirmDeleteReceipt() {
    if (!deletingId) return;
    const id = deletingId;
    setDeleteBusy(true);
    const res = await fetch(`/api/receipts/${id}`, { method: "DELETE" });
    if (!res.ok) setError(apiError(await res.json().catch(() => null), t("deleteFailed")));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    await load();
    setDeleteBusy(false);
    setDeletingId(null);
  }

  // Skip AI extraction and go straight to a claim of blank rows the user fills
  // in — the escape hatch when the provider is rate-limited. Aborts the running
  // extraction stream first so it stops waiting out the cooldown.
  async function generateManualClaim() {
    bailingToManual.current = true;
    generateAbort.current?.abort();
    setWaiting(false);
    setStatus(t("manualSetup"));
    try {
      const res = await fetch("/api/reimbursements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptIds: Array.from(selected), manual: true }),
      });
      if (!res.ok) throw new Error(apiError(await res.json().catch(() => null), t("manualStartFailed")));
      const { reimbursement } = await res.json();
      router.push(`/claims/${reimbursement.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("manualStartFailed"));
      setGenerating(false);
      setStatus(null);
    }
  }

  function handleGenerateClaimClick() {
    if (selected.size === 0) {
      setShowSelectHint(true);
      if (selectHintTimeout.current) clearTimeout(selectHintTimeout.current);
      // Long enough for the ✓ nudge rings (3 × 1s) to finish.
      selectHintTimeout.current = setTimeout(() => setShowSelectHint(false), 3000);
      return;
    }
    generateClaim();
  }

  async function generateClaim() {
    setGenerating(true);
    setWaiting(false);
    setError(null);
    setStatus(t("readingInitial"));
    bailingToManual.current = false;
    const abort = new AbortController();
    generateAbort.current = abort;
    try {
      const res = await fetch("/api/reimbursements", {
        method: "POST",
        // Ask for streamed progress so quota waits show up live.
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({ receiptIds: Array.from(selected) }),
        signal: abort.signal,
      });
      // A pre-stream failure (auth/validation) comes back as plain JSON.
      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => ({}));
        throw new Error(apiError(json, t("generateFailed")));
      }

      let claimId: string | null = null;

      const handle = (ev: ClaimStreamMessage) => {
        switch (ev.type) {
          case "status":
            setStatus(t("readingCount", { total: ev.total }));
            break;
          case "receipt-done":
            setWaiting(false);
            setStatus(t("readProgress", { completed: ev.completed, total: ev.total }));
            break;
          case "quota-wait":
            setWaiting(true);
            setWaitCooldownMs(ev.cooldownMs);
            setWaitKey((k) => k + 1);
            setStatus(
              tErrors("quotaWait", {
                seconds: Math.round(ev.cooldownMs / 1000),
                attempt: ev.attempt,
                maxRetries: ev.maxRetries,
              })
            );
            break;
          case "done":
            claimId = ev.reimbursementId;
            break;
          case "error":
            throw new Error(apiError(ev, t("generateFailed")));
        }
      };

      await readNdjsonStream<ClaimStreamMessage>(res.body, handle);

      if (!claimId) throw new Error(t("generateEnded"));
      router.push(`/claims/${claimId}`);
    } catch (e) {
      // The user bailed to manual entry — generateManualClaim now owns the UI.
      if (bailingToManual.current) return;
      setError(e instanceof Error ? e.message : t("generateFailed"));
      setGenerating(false);
      setWaiting(false);
      setStatus(null);
    }
  }

  const unassigned = (receipts ?? []).filter((r) => r.status === "unassigned");
  const processed = (receipts ?? []).filter((r) => r.status !== "unassigned");
  const hasClaimBar = receipts !== null && (unassigned.length > 0 || processed.length > 0);
  const barEmpty = selected.size === 0;

  // ?open=<id> deep-link landing (search results → "Find in Receipts"):
  // auto-expand the processed section when the target lives there, scroll +
  // pulse, toast on a miss. Shared contract in src/lib/use-open-param.ts.
  const processedDetails = useRef<HTMLDetailsElement>(null);
  const [openGone, setOpenGone] = useState(false);
  useOpenParam({
    ready: receipts !== null,
    exists: (id) => (receipts ?? []).some((r) => r.id === id),
    beforeScroll: (id) => {
      if ((receipts ?? []).find((r) => r.id === id)?.status !== "unassigned") {
        processedDetails.current?.setAttribute("open", "");
      }
    },
    onGone: () => setOpenGone(true),
  });

  return (
    <div
      // pb clears the fixed bottom dock (the claim bar) on phones.
      className={`relative space-y-6 ${hasClaimBar ? "pb-24 sm:pb-0" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-testid="shoebox-dropzone"
    >
      {dragging && (
        <div
          className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-indigo-900/20 p-4"
          data-testid="shoebox-drop-overlay"
        >
          <div className="card flex flex-col items-center gap-2 border-2 border-dashed border-indigo-400 bg-white/95 px-10 py-8 text-center shadow-lg">
            <div className="text-4xl">📥</div>
            <p className="font-semibold text-indigo-900">{t("dropTitle")}</p>
            <p className="text-sm text-stone-500">{t("dropBody")}</p>
          </div>
        </div>
      )}
      <div>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-3xl font-bold short:text-xl">{t("title")}</h1>
          <div className="shrink-0">
            <input
              ref={fileInput}
              type="file"
              accept="image/*,application/pdf"
              multiple
              className="hidden"
              data-testid="file-input"
              onChange={(e) => onFilesPicked(e.target.files)}
            />
            <button
              className="btn-primary"
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
              data-testid="upload-button"
            >
              {uploading ? t("uploading") : t("upload")}
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-sm text-stone-500 short:hidden">{t("intro")}</p>
      </div>

      {error && (
        <div className="card border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}

      {openGone && (
        <div className="card border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" role="status" data-testid="open-gone-toast">
          {t("openGoneToast")}
        </div>
      )}

      {/* Search pill and claim bar share one row from `sm` up (search keeps a
          fixed width, the claim bar owns the rest). Below `sm` the claim bar
          is the SAME element repositioned into a fixed dock at the bottom of
          the screen — one element so data-testid="generate-claim" stays
          unique — and the search pill has the row to itself. */}
      {(searchEnabled || hasClaimBar) && (
        <div className="z-30 flex items-start gap-3 sm:sticky sm:top-16 sm:items-stretch">
          {searchEnabled && (
            <Link
              href="/search?type=receipt"
              data-testid="shoebox-search-pill"
              className="card pressable flex min-w-0 flex-1 items-center gap-2 px-4 py-2.5 text-sm text-stone-500 sm:w-56 sm:flex-none md:w-72"
            >
              <span aria-hidden>🔍</span> {t("searchPill")}
            </Link>
          )}
          {hasClaimBar && (
            <div
              className={`min-w-0 flex-none sm:flex-1 ${
                barEmpty && !generating ? "sm:flex sm:items-stretch sm:justify-end" : ""
              }`}
            >
              <div
                className={`fixed inset-x-0 bottom-0 z-30 flex flex-col justify-center gap-2 border-t bg-white pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] transition-all duration-200 sm:static sm:inset-x-auto sm:min-h-11 sm:rounded-xl sm:border sm:p-2 sm:pl-3.5 ${
                  showSelectHint
                    ? "border-indigo-400 shadow-[0_-8px_24px_rgba(79,70,229,0.18)] sm:shadow-none sm:ring-4 sm:ring-indigo-600/15"
                    : "border-stone-200 shadow-[0_-8px_24px_rgba(0,0,0,0.12)] sm:shadow-sm"
                } ${
                  barEmpty && !generating
                    ? `sm:w-max sm:max-w-full sm:bg-indigo-50/80 sm:backdrop-blur-sm ${showSelectHint ? "" : "sm:border-indigo-200"}`
                    : "sm:w-auto"
                }`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`min-w-0 text-sm transition-colors duration-200 ${
                      barEmpty
                        ? `text-[13px] font-semibold ${showSelectHint ? "text-indigo-700" : "text-indigo-900"}`
                        : "font-semibold text-stone-900"
                    }`}
                    data-testid={showSelectHint ? "select-receipt-hint" : undefined}
                  >
                    {barEmpty ? (
                      showSelectHint ? (
                        <>
                          <span className="sm:hidden">{t("selectHintShort")}</span>
                          <span className="hidden sm:inline">{t("selectHint")}</span>
                        </>
                      ) : (
                        <>
                          <span className="md:hidden">{t("selectPromptShort")}</span>
                          <span className="hidden md:inline">{t("selectPrompt")}</span>
                        </>
                      )
                    ) : (
                      <>
                        <span className="md:hidden">{t("selectedCountShort", { count: selected.size })}</span>
                        <span className="hidden md:inline">{t("selectedCount", { count: selected.size })}</span>
                      </>
                    )}
                  </span>
                  {!barEmpty && !generating && (
                    <button
                      className="text-[13px] text-stone-500 underline underline-offset-2 hover:text-stone-700"
                      onClick={() => setSelected(new Set())}
                      data-testid="clear-selection"
                    >
                      {t("clearSelection")}
                    </button>
                  )}
                  <span className="flex-1" />
                  <button
                    className={`whitespace-nowrap ${
                      barEmpty && !generating
                        ? "inline-flex items-center justify-center gap-2 rounded-lg border border-indigo-200 bg-white px-3.5 py-1.5 text-sm font-semibold text-indigo-600 transition duration-150 ease-out hover:border-indigo-300 hover:text-indigo-700 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
                        : "btn-primary"
                    } ${showSelectHint ? "shake-x" : ""}`}
                    onClick={handleGenerateClaimClick}
                    disabled={generating}
                    aria-disabled={selected.size === 0}
                    data-testid="generate-claim"
                  >
                    {generating
                      ? waiting
                        ? t("waitingRateLimit")
                        : t("readingShort")
                      : t("newClaim")}
                  </button>
                </div>
                {generating && status && (
                  <div
                    className="flex items-center gap-2"
                    role="status"
                    aria-live="polite"
                    data-testid="generate-status"
                  >
                    {waiting && waitCooldownMs > 0 && (
                      <QuotaWaitRing key={waitKey} durationMs={waitCooldownMs} />
                    )}
                    <span className={`text-xs ${waiting ? "font-medium text-amber-700" : "text-indigo-700"}`}>
                      {status}
                    </span>
                    {waiting && (
                      <button
                        className="ml-1 rounded px-2 py-1 text-xs font-semibold text-amber-800 underline underline-offset-2 hover:bg-amber-100"
                        onClick={generateManualClaim}
                        data-testid="generate-claim-manual"
                      >
                        {t("manualInstead")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {receipts === null ? (
        <p className="text-sm text-stone-500">{tCommon("loading")}</p>
      ) : unassigned.length === 0 && processed.length === 0 ? (
        <div className="card p-10 text-center text-stone-500">
          <div className="text-4xl">🧾</div>
          <p className="mt-2 font-medium">{t("emptyTitle")}</p>
          <p className="text-sm">{t("emptyBody")}</p>
          <div className="mt-6 flex justify-center">
            <LocaleSwitcher signedIn variant="prominent" />
          </div>
          <ol className="mx-auto mt-8 grid max-w-3xl gap-3 text-left text-sm text-stone-600 sm:grid-cols-4">
            {(["step1", "step2", "step3", "step4"] as const).map((step) => (
              <li key={step}>
                {t.rich(step, {
                  step: (chunks) => <span className="font-semibold text-indigo-700">{chunks}</span>,
                })}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <>
          <ReceiptGrid
            receipts={unassigned}
            selectable
            selected={selected}
            onToggle={toggle}
            onDelete={deleteReceipt}
            onSaveNote={saveNote}
            fileUrl={fileUrl}
            onView={setViewing}
            nudgeSelect={showSelectHint}
          />
          {processed.length > 0 && (
            <details className="pt-2" ref={processedDetails}>
              <summary className="cursor-pointer text-sm font-medium text-stone-500">
                {t("processedSummary", { count: processed.length })}
              </summary>
              <p className="mt-1 text-xs text-stone-400">{t("processedNote")}</p>
              <div className="mt-3">
                <ReceiptGrid
                  receipts={processed}
                  selectable
                  selected={selected}
                  onToggle={toggle}
                  onDelete={deleteReceipt}
                  onSaveNote={saveNote}
                  fileUrl={fileUrl}
                  onView={setViewing}
                />
              </div>
            </details>
          )}
        </>
      )}

      {preparing && (
        // Bottom sheet on phones, centred card on desktop. Three bands: a fixed
        // header carrying the title + the note field the dialog is named after
        // (task-first — reachable without scrolling past the photo), a
        // scrollable middle for the rotate/crop tool, and a footer pinned to the
        // sheet's bottom edge so Save stays above the keyboard on a short
        // viewport. dvh (not vh) so the cap tracks the keyboard-shrunk viewport.
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal
        >
          <div className="card flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-b-none rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)] sm:rounded-2xl sm:pb-0">
            <div className="shrink-0 border-b border-stone-100 px-6 pt-6 pb-4">
              <h2 className="font-bold">
                {t("prepareTitle")}
                {pending.length > 1 && (
                  <span className="ml-1 font-normal text-stone-400">{t("prepareLeft", { count: pending.length })}</span>
                )}
              </h2>
              <p className="mt-1 truncate text-sm text-stone-500">
                {preparing.kind === "local" ? preparing.file.name : preparing.receipt.originalName}
              </p>
              <label className="mt-3 block text-sm font-medium">
                {t("noteLabel")}
                <input
                  key={preparing.key}
                  className="input mt-1"
                  placeholder={t("notePlaceholder")}
                  value={uploadNote}
                  onChange={(e) => setUploadNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") savePrepare();
                  }}
                  maxLength={300}
                  autoFocus
                  data-testid="upload-note"
                />
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              {preparing.kind === "uploaded" ? (
                <div
                  className="flex max-h-72 items-center justify-center overflow-hidden rounded-lg bg-stone-100"
                  data-testid="upload-preview"
                >
                  <div className="max-h-72 w-full overflow-y-auto">
                    <PdfReceiptPreview
                      receiptId={preparing.receipt.id}
                      fileHref={fileUrl(preparing.receipt.id)}
                    />
                  </div>
                </div>
              ) : (
                // The rotate/crop tool IS the preview — straighten/trim in place.
                <div data-testid="upload-preview">
                  <ReceiptImageEditor
                    key={preparing.key}
                    embedded
                    src={preparing.previewUrl}
                    onChange={setEditTransform}
                    maxStageHeight={300}
                  />
                </div>
              )}
              <p className="mt-2 text-xs text-stone-400">
                {preparing.kind === "local" ? t("prepareHintLocal") : t("prepareHintUploaded")}
              </p>
            </div>
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-stone-100 px-6 py-4">
              {pending.length > 1 && (
                <button
                  className="mr-auto rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100"
                  onClick={skipAllPrepare}
                  disabled={uploading}
                  data-testid="upload-note-skip-all"
                >
                  {t("skipAll")}
                </button>
              )}
              <button
                className="btn-primary"
                onClick={savePrepare}
                disabled={uploading}
                data-testid="upload-note-confirm"
              >
                {uploading ? t("uploading") : tCommon("save")}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deletingId !== null}
        message={t("deleteConfirm")}
        confirmLabel={t("deleteConfirmButton")}
        busy={deleteBusy}
        onConfirm={confirmDeleteReceipt}
        onCancel={() => setDeletingId(null)}
        testId="delete-receipt-confirm"
      />

      {viewing && (
        <ReceiptViewer
          receipt={viewing}
          onClose={() => setViewing(null)}
          onEdited={() => {
            // Bump the version so card thumbnails cache-bust past the file
            // route's max-age (the viewer busts its own image internally).
            setFileVersions((prev) => ({ ...prev, [viewing.id]: (prev[viewing.id] ?? 0) + 1 }));
            load();
          }}
        />
      )}
    </div>
  );
}

/**
 * A ring that fills from empty to full over `durationMs` (the quota cooldown)
 * with a live seconds countdown in the middle, so a rate-limit wait shows
 * visible progress instead of a frozen spinner. Remount (via a changing key)
 * to restart it for a new wait.
 */
function QuotaWaitRing({ durationMs }: { durationMs: number }) {
  const t = useTranslations("Shoebox");
  const R = 14;
  const C = 2 * Math.PI * R;
  const [offset, setOffset] = useState(C); // start empty
  const [remaining, setRemaining] = useState(Math.ceil(durationMs / 1000));

  useEffect(() => {
    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    // Let the empty ring paint, then flip to full so the transition animates.
    const rafs: number[] = [];
    rafs.push(
      requestAnimationFrame(() => rafs.push(requestAnimationFrame(() => setOffset(0))))
    );
    const start = now();
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((durationMs - (now() - start)) / 1000));
      setRemaining(left);
      if (left <= 0) clearInterval(timer);
    }, 250);
    return () => {
      rafs.forEach(cancelAnimationFrame);
      clearInterval(timer);
    };
  }, [durationMs]);

  return (
    <svg
      width="34"
      height="34"
      viewBox="0 0 36 36"
      className="shrink-0"
      role="img"
      aria-label={t("quotaRingAria", { seconds: remaining })}
    >
      <circle cx="18" cy="18" r={R} fill="none" strokeWidth="3" className="stroke-amber-200" />
      <circle
        cx="18"
        cy="18"
        r={R}
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        className="stroke-amber-500"
        transform="rotate(-90 18 18)"
        style={{
          strokeDasharray: C,
          strokeDashoffset: offset,
          transition: `stroke-dashoffset ${durationMs}ms linear`,
        }}
      />
      <text
        x="18"
        y="18"
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-amber-700 text-[10px] font-semibold tabular-nums"
      >
        {remaining}
      </text>
    </svg>
  );
}
