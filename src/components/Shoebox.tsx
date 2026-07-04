"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReceiptImageEditor from "@/components/ReceiptImageEditor";
import ReceiptViewer from "./ReceiptViewer";
import ReceiptGrid, { type ReceiptSummary as Receipt } from "./ReceiptGrid";
import { readNdjsonStream } from "@/lib/ndjson";
import type { ClaimStreamMessage } from "@/lib/claim-stream";

export default function Shoebox() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Just-uploaded receipts awaiting the optional describe step (front = current).
  const [describeQueue, setDescribeQueue] = useState<Receipt[]>([]);
  const [uploadNote, setUploadNote] = useState("");
  const [uploading, setUploading] = useState(false);
  // Rotate/crop editor open for the receipt currently in the describe step.
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
  const [waitCooldownMs, setWaitCooldownMs] = useState(0);
  // Bumped on each quota wait so the countdown ring remounts and restarts.
  const [waitKey, setWaitKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Receipt | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/receipts");
    if (res.ok) setReceipts((await res.json()).receipts);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function onFilesPicked(files: FileList | null) {
    if (!files || files.length === 0) return;
    // Upload immediately (capture must be instant), then step through the
    // uploaded receipts asking for an optional description with the actual
    // image on screen.
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("files", f);
      const res = await fetch("/api/receipts", { method: "POST", body: form });
      if (!res.ok) throw new Error((await res.json()).error ?? "Upload failed");
      const { receipts: created } = await res.json();
      await load();
      setUploadNote("");
      setDescribeQueue(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const describing: Receipt | null = describeQueue[0] ?? null;

  function skipDescribe(all = false) {
    setUploadNote("");
    setEditingUpload(false);
    setDescribeQueue((q) => (all ? [] : q.slice(1)));
  }

  async function saveDescribe() {
    if (describing && uploadNote.trim()) await saveNote(describing.id, uploadNote.trim());
    skipDescribe();
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

  async function generateClaim() {
    setGenerating(true);
    setWaiting(false);
    setError(null);
    setStatus("Reading receipts with AI…");
    try {
      const res = await fetch("/api/reimbursements", {
        method: "POST",
        // Ask for streamed progress so quota waits show up live.
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({ receiptIds: Array.from(selected) }),
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
      setError(e instanceof Error ? e.message : "Claim generation failed");
      setGenerating(false);
      setWaiting(false);
      setStatus(null);
    }
  }

  const unassigned = (receipts ?? []).filter((r) => r.status === "unassigned");
  const processed = (receipts ?? []).filter((r) => r.status !== "unassigned");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Shoebox</h1>
          <p className="text-sm text-stone-500">
            Drop receipts here as you go. Select some when you&apos;re ready to file a claim.
          </p>
        </div>
        <div>
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

      {error && (
        <div className="card border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}

      <div
        className={`card sticky top-16 z-30 flex min-h-16 flex-col justify-center gap-2 p-3 transition-colors ${
          selected.size > 0 ? "border-indigo-200 bg-indigo-50" : ""
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <span
            className={`truncate text-sm font-medium ${selected.size > 0 ? "text-indigo-900" : "text-stone-500"}`}
          >
            {selected.size > 0
              ? `${selected.size} receipt${selected.size > 1 ? "s" : ""} selected`
              : "Select receipts to claim"}
          </span>
          {selected.size > 0 && (
            <button
              className="btn-primary shrink-0 whitespace-nowrap"
              onClick={generateClaim}
              disabled={generating}
              data-testid="generate-claim"
            >
              {generating
                ? waiting
                  ? "Waiting on rate limit…"
                  : "Reading receipts…"
                : "✨ Generate Claim"}
            </button>
          )}
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
          </div>
        )}
      </div>

      {receipts === null ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : unassigned.length === 0 && processed.length === 0 ? (
        <div className="card p-10 text-center text-stone-500">
          <div className="text-4xl">🥿</div>
          <p className="mt-2 font-medium">Your shoebox is empty</p>
          <p className="text-sm">Upload a photo or PDF of a receipt to get started.</p>
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

      {describing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal
        >
          <div className="card w-full max-w-md p-6">
            <h2 className="font-bold">
              Describe this receipt
              {describeQueue.length > 1 && (
                <span className="ml-1 font-normal text-stone-400">
                  ({describeQueue.length} left)
                </span>
              )}
            </h2>
            <div className="mt-1 flex items-center justify-between gap-2">
              <p className="truncate text-sm text-stone-500">{describing.originalName}</p>
              {describing.mimeType.startsWith("image/") && (
                <button
                  className="shrink-0 rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 hover:text-stone-700"
                  onClick={() => setEditingUpload(true)}
                  title="Rotate or crop this receipt photo"
                  data-testid={`edit-image-${describing.id}`}
                >
                  ✂ Rotate / crop
                </button>
              )}
            </div>
            <div
              className="mt-3 flex max-h-72 items-center justify-center overflow-hidden rounded-lg bg-stone-100"
              data-testid="upload-preview"
            >
              {describing.mimeType === "application/pdf" ? (
                <object
                  data={fileUrl(describing.id)}
                  type="application/pdf"
                  className="h-72 w-full"
                >
                  <div className="p-8 text-center text-stone-400">
                    <div className="text-4xl">📄</div>
                    <div className="text-xs font-semibold">PDF</div>
                  </div>
                </object>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={fileUrl(describing.id)}
                  src={fileUrl(describing.id)}
                  alt={describing.originalName}
                  className="max-h-72 w-auto"
                />
              )}
            </div>
            <label className="mt-4 block text-sm font-medium">
              Description (optional)
              <input
                key={describing.id}
                className="input mt-1"
                placeholder="e.g. VBS craft supplies"
                value={uploadNote}
                onChange={(e) => setUploadNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveDescribe();
                }}
                maxLength={300}
                autoFocus
                data-testid="upload-note"
              />
            </label>
            <p className="mt-2 text-xs text-stone-400">You can edit it on the card later.</p>
            <div className="mt-5 flex items-center justify-end gap-2">
              {describeQueue.length > 1 && (
                <button
                  className="mr-auto rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100"
                  onClick={() => skipDescribe(true)}
                  data-testid="upload-note-skip-all"
                >
                  Skip all
                </button>
              )}
              <button
                className="btn-secondary"
                onClick={() => skipDescribe()}
                data-testid="upload-note-cancel"
              >
                Skip
              </button>
              <button className="btn-primary" onClick={saveDescribe} data-testid="upload-note-confirm">
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {editingUpload && describing && (
        <ReceiptImageEditor
          receiptId={describing.id}
          src={fileUrl(describing.id)}
          onClose={() => setEditingUpload(false)}
          onSaved={() => {
            setFileVersions((prev) => ({
              ...prev,
              [describing.id]: (prev[describing.id] ?? 0) + 1,
            }));
            setEditingUpload(false);
            load();
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
