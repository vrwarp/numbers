"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReceiptImageEditor from "@/components/ReceiptImageEditor";
import ReceiptViewer from "./ReceiptViewer";
import PdfReceiptPreview from "@/components/PdfReceiptPreview";
import ReceiptGrid, { type ReceiptSummary as Receipt } from "./ReceiptGrid";
import { prepareImageUpload, renderTransformedImage } from "@/lib/image-client";
import { readNdjsonStream } from "@/lib/ndjson";
import type { ClaimStreamMessage } from "@/lib/claim-stream";

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

export default function Shoebox() {
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
  // Rotate/crop editor open for the file currently in the prepare step.
  const [editingUpload, setEditingUpload] = useState(false);
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
      if (!res.ok) throw new Error((await res.json()).error ?? "Upload failed");
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
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  // Picked photos exist only in this tab until their dialog is dismissed —
  // warn before a navigation throws them away. (Uploaded PDFs are safe.)
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
      if (!res.ok) throw new Error((await res.json()).error ?? "Upload failed");
      const done = new Set(items.map((i) => i.key));
      for (const item of items) URL.revokeObjectURL(item.previewUrl);
      setPending((q) => q.filter((i) => !done.has(i.key)));
      setUploadNote("");
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
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

  async function skipPrepare(all = false) {
    if (!preparing) return;
    setEditingUpload(false);
    const items = all ? pending : [preparing];
    // Already-uploaded PDFs just leave the queue (their note is skipped) …
    const done = new Set(items.filter((i) => i.kind === "uploaded").map((i) => i.key));
    if (done.size > 0) {
      setUploadNote("");
      setPending((q) => q.filter((i) => !done.has(i.key)));
    }
    // … while local images upload now.
    const locals = items.filter((i): i is LocalPending => i.kind === "local");
    if (locals.length > 0) await uploadPending(locals);
  }

  async function savePrepare() {
    if (!preparing) return;
    setEditingUpload(false);
    const note = uploadNote.trim() || undefined;
    if (preparing.kind === "uploaded") {
      if (note) await saveNote(preparing.receipt.id, note);
      setUploadNote("");
      setPending((q) => q.slice(1));
    } else {
      await uploadPending([preparing], note);
    }
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
    if (!res.ok) setError((await res.json()).error ?? "Could not save the description");
    await load();
  }

  async function deleteReceipt(id: string) {
    if (!confirm("Delete this receipt?")) return;
    const res = await fetch(`/api/receipts/${id}`, { method: "DELETE" });
    if (!res.ok) setError((await res.json()).error ?? "Delete failed");
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    await load();
  }

  // Skip AI extraction and go straight to a claim of blank rows the user fills
  // in — the escape hatch when the provider is rate-limited. Aborts the running
  // extraction stream first so it stops waiting out the cooldown.
  async function generateManualClaim() {
    bailingToManual.current = true;
    generateAbort.current?.abort();
    setWaiting(false);
    setStatus("Setting up manual entry…");
    try {
      const res = await fetch("/api/reimbursements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptIds: Array.from(selected), manual: true }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not start manual entry");
      const { reimbursement } = await res.json();
      router.push(`/claims/${reimbursement.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start manual entry");
      setGenerating(false);
      setStatus(null);
    }
  }

  function handleGenerateClaimClick() {
    if (selected.size === 0) {
      setShowSelectHint(true);
      if (selectHintTimeout.current) clearTimeout(selectHintTimeout.current);
      selectHintTimeout.current = setTimeout(() => setShowSelectHint(false), 2000);
      return;
    }
    generateClaim();
  }

  async function generateClaim() {
    setGenerating(true);
    setWaiting(false);
    setError(null);
    setStatus("Reading receipts with AI…");
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
        throw new Error(json.error ?? "Claim generation failed");
      }

      let claimId: string | null = null;

      const handle = (ev: ClaimStreamMessage) => {
        switch (ev.type) {
          case "status":
            setStatus(`Reading ${ev.total} receipt${ev.total > 1 ? "s" : ""} with AI…`);
            break;
          case "receipt-done":
            setWaiting(false);
            setStatus(`Read ${ev.completed} of ${ev.total} receipts…`);
            break;
          case "quota-wait":
            setWaiting(true);
            setWaitCooldownMs(ev.cooldownMs);
            setWaitKey((k) => k + 1);
            setStatus(ev.message);
            break;
          case "done":
            claimId = ev.reimbursementId;
            break;
          case "error":
            throw new Error(ev.message);
        }
      };

      await readNdjsonStream<ClaimStreamMessage>(res.body, handle);

      if (!claimId) throw new Error("Claim generation ended unexpectedly");
      router.push(`/claims/${claimId}`);
    } catch (e) {
      // The user bailed to manual entry — generateManualClaim now owns the UI.
      if (bailingToManual.current) return;
      setError(e instanceof Error ? e.message : "Claim generation failed");
      setGenerating(false);
      setWaiting(false);
      setStatus(null);
    }
  }

  const unassigned = (receipts ?? []).filter((r) => r.status === "unassigned");
  const processed = (receipts ?? []).filter((r) => r.status !== "unassigned");

  return (
    <div
      className="relative space-y-6"
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
            <p className="font-semibold text-indigo-900">Drop receipts to upload</p>
            <p className="text-sm text-stone-500">Images or PDFs</p>
          </div>
        </div>
      )}
      <div>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Shoebox</h1>
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
              {uploading ? "Uploading…" : "📷 Upload Receipt"}
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-sm text-stone-500">
          Drop receipts here as you go. Select some when you&apos;re ready to file a claim.
        </p>
      </div>

      {error && (
        <div className="card border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}

      {receipts !== null && (unassigned.length > 0 || processed.length > 0) && (
        <div
          className={`card sticky top-16 z-30 flex min-h-16 flex-col justify-center gap-2 p-3 transition-all duration-200 ${
            selected.size > 0 ? "" : "border-indigo-200 bg-indigo-50/80 shadow-md"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <span className="text-xl select-none" role="img" aria-hidden="true">
                🧾
              </span>
              <span
                className={`text-sm transition-colors duration-200 ${
                  selected.size > 0 ? "font-medium text-stone-700" : "font-semibold text-indigo-900"
                }`}
              >
                {selected.size > 0
                  ? `${selected.size} receipt${selected.size > 1 ? "s" : ""} selected`
                  : "Select receipts below to start a claim"}
              </span>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <button
                className={`btn-primary whitespace-nowrap ${
                  selected.size === 0 ? "cursor-not-allowed opacity-40" : ""
                } ${showSelectHint ? "shake-x" : ""}`}
                onClick={handleGenerateClaimClick}
                disabled={generating}
                aria-disabled={selected.size === 0}
                data-testid="generate-claim"
              >
                {generating
                  ? waiting
                    ? "Waiting on rate limit…"
                    : "Reading receipts…"
                  : "✨ New Claim"}
              </button>
              {showSelectHint && (
                <span
                  className="text-xs font-medium text-indigo-700"
                  data-testid="select-receipt-hint"
                >
                  Select a receipt first ↑
                </span>
              )}
            </div>
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
                  Enter manually instead
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {receipts === null ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : unassigned.length === 0 && processed.length === 0 ? (
        <div className="card p-10 text-center text-stone-500">
          <div className="text-4xl">🥿</div>
          <p className="mt-2 font-medium">Your shoebox is empty</p>
          <p className="text-sm">Upload a photo or PDF of a receipt to get started.</p>
          <ol className="mx-auto mt-8 grid max-w-3xl gap-3 text-left text-sm text-stone-600 sm:grid-cols-4">
            <li><span className="font-semibold text-indigo-700">1. Snap.</span> Photograph receipts into your Shoebox the moment you buy.</li>
            <li><span className="font-semibold text-indigo-700">2. Batch.</span> Later, when you&apos;re ready, select receipts and hit New Claim — AI drafts the line items.</li>
            <li><span className="font-semibold text-indigo-700">3. Verify.</span> Check every row against the receipt. Fix, split, or exclude items.</li>
            <li><span className="font-semibold text-indigo-700">4. Print.</span> Download the filled CFCC form with receipts attached, sign, and drop it off.</li>
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
          />
          {processed.length > 0 && (
            <details className="pt-2">
              <summary className="cursor-pointer text-sm font-medium text-stone-500">
                Processed receipts ({processed.length})
              </summary>
              <p className="mt-1 text-xs text-stone-400">
                Already on a generated claim — still selectable if part of the purchase belongs
                on another claim.
              </p>
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal
        >
          <div className="card w-full max-w-md p-6">
            <h2 className="font-bold">
              Describe this receipt
              {pending.length > 1 && (
                <span className="ml-1 font-normal text-stone-400">({pending.length} left)</span>
              )}
            </h2>
            <div className="mt-1 flex items-center justify-between gap-2">
              <p className="truncate text-sm text-stone-500">
                {preparing.kind === "local" ? preparing.file.name : preparing.receipt.originalName}
              </p>
              {preparing.kind === "local" && (
                <button
                  className="shrink-0 rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 hover:text-stone-700"
                  onClick={() => setEditingUpload(true)}
                  disabled={uploading}
                  title="Rotate or crop this receipt photo"
                  data-testid={`edit-image-pending-${preparing.key}`}
                >
                  ✂ Rotate / crop
                </button>
              )}
            </div>
            <div
              className="mt-3 flex max-h-72 items-center justify-center overflow-hidden rounded-lg bg-stone-100"
              data-testid="upload-preview"
            >
              {preparing.kind === "uploaded" ? (
                <div className="max-h-72 w-full overflow-y-auto">
                  <PdfReceiptPreview
                    receiptId={preparing.receipt.id}
                    fileHref={fileUrl(preparing.receipt.id)}
                  />
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={preparing.previewUrl}
                  src={preparing.previewUrl}
                  alt={preparing.file.name}
                  className="max-h-72 w-auto"
                />
              )}
            </div>
            <label className="mt-4 block text-sm font-medium">
              Description (optional)
              <input
                key={preparing.key}
                className="input mt-1"
                placeholder="e.g. VBS craft supplies"
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
            <p className="mt-2 text-xs text-stone-400">
              {preparing.kind === "local"
                ? "Uploads when you save or skip. You can edit the description on the card later."
                : "You can edit the description on the card later."}
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              {pending.length > 1 && (
                <button
                  className="mr-auto rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100"
                  onClick={() => skipPrepare(true)}
                  disabled={uploading}
                  data-testid="upload-note-skip-all"
                >
                  Skip all
                </button>
              )}
              <button
                className="btn-secondary"
                onClick={() => skipPrepare()}
                disabled={uploading}
                data-testid="upload-note-cancel"
              >
                Skip
              </button>
              <button
                className="btn-primary"
                onClick={savePrepare}
                disabled={uploading}
                data-testid="upload-note-confirm"
              >
                {uploading ? "Uploading…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingUpload && preparing?.kind === "local" && (
        <ReceiptImageEditor
          src={preparing.previewUrl}
          onClose={() => setEditingUpload(false)}
          onSaved={() => setEditingUpload(false)}
          onApply={async (t) => {
            // Render the rotate/crop on this device at the photo's native
            // resolution; the result replaces the pending file's working image.
            const rendered = await renderTransformedImage(
              preparing.edited ?? preparing.file,
              t
            );
            const url = URL.createObjectURL(rendered);
            URL.revokeObjectURL(preparing.previewUrl);
            setPending((q) =>
              q.map((i) =>
                i.key === preparing.key ? { ...i, edited: rendered, previewUrl: url } : i
              )
            );
          }}
        />
      )}

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
      aria-label={`Retrying in about ${remaining} second${remaining === 1 ? "" : "s"}`}
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
