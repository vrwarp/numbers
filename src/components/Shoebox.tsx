"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface ClaimRef {
  id: string;
  status: string;
  createdAt: string;
}

interface Receipt {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  note: string;
  createdAt: string;
  claims: ClaimRef[];
}

export default function Shoebox() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Files picked but not yet uploaded — the describe-and-upload dialog is open.
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  const [uploadNote, setUploadNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/receipts");
    if (res.ok) setReceipts((await res.json()).receipts);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function onFilesPicked(files: FileList | null) {
    if (!files || files.length === 0) return;
    // Stash the picked files and ask for an optional description first —
    // the upload happens when the dialog is confirmed.
    setPendingFiles(Array.from(files));
    setUploadNote("");
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function confirmUpload() {
    if (!pendingFiles || pendingFiles.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      for (const f of pendingFiles) form.append("files", f);
      if (uploadNote.trim()) form.append("note", uploadNote.trim());
      const res = await fetch("/api/receipts", { method: "POST", body: form });
      if (!res.ok) throw new Error((await res.json()).error ?? "Upload failed");
      setPendingFiles(null);
      setUploadNote("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
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

  async function generateClaim() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/reimbursements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptIds: Array.from(selected) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Claim generation failed");
      router.push(`/claims/${json.reimbursement.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Claim generation failed");
      setGenerating(false);
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

      {selected.size > 0 && (
        <div className="card sticky top-16 z-30 flex items-center justify-between border-indigo-200 bg-indigo-50 p-3">
          <span className="text-sm font-medium text-indigo-900">
            {selected.size} receipt{selected.size > 1 ? "s" : ""} selected
          </span>
          <button className="btn-primary" onClick={generateClaim} disabled={generating} data-testid="generate-claim">
            {generating ? "Reading receipts with AI…" : "✨ Generate Claim"}
          </button>
        </div>
      )}

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
                />
              </div>
            </details>
          )}
        </>
      )}

      {pendingFiles && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal
        >
          <div className="card w-full max-w-sm p-6">
            <h2 className="font-bold">
              Upload {pendingFiles.length} receipt{pendingFiles.length > 1 ? "s" : ""}
            </h2>
            <p className="mt-1 truncate text-sm text-stone-500">
              {pendingFiles.map((f) => f.name).join(", ")}
            </p>
            <label className="mt-4 block text-sm font-medium">
              Description (optional)
              <input
                className="input mt-1"
                placeholder="e.g. VBS craft supplies"
                value={uploadNote}
                onChange={(e) => setUploadNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmUpload();
                }}
                maxLength={300}
                autoFocus
                data-testid="upload-note"
              />
            </label>
            <p className="mt-2 text-xs text-stone-400">
              {pendingFiles.length > 1 ? "Applies to all files in this upload; you" : "You"} can
              edit it on the card later.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="btn-secondary"
                onClick={() => setPendingFiles(null)}
                disabled={uploading}
                data-testid="upload-note-cancel"
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={confirmUpload}
                disabled={uploading}
                data-testid="upload-note-confirm"
              >
                {uploading ? "Uploading…" : "⬆ Upload"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ReceiptGrid({
  receipts,
  selectable = false,
  selected,
  onToggle,
  onDelete,
  onSaveNote,
}: {
  receipts: Receipt[];
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  onDelete?: (id: string) => void;
  onSaveNote?: (id: string, note: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {receipts.map((r) => {
        const isSelected = selected?.has(r.id) ?? false;
        return (
          <div
            key={r.id}
            data-testid={`receipt-card-${r.id}`}
            className={`card relative overflow-hidden transition-shadow ${
              selectable ? "cursor-pointer" : "opacity-70"
            } ${isSelected ? "ring-2 ring-indigo-500" : ""}`}
            onClick={selectable ? () => onToggle?.(r.id) : undefined}
          >
            {selectable && (
              <div
                className={`absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs font-bold ${
                  isSelected
                    ? "border-indigo-600 bg-indigo-600 text-white"
                    : "border-stone-300 bg-white text-transparent"
                }`}
                aria-checked={isSelected}
                role="checkbox"
              >
                ✓
              </div>
            )}
            {onDelete && (
              <button
                className="absolute right-2 top-2 z-10 rounded-full bg-white/90 px-2 py-1 text-xs text-stone-500 shadow hover:text-red-600"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(r.id);
                }}
                aria-label={`Delete ${r.originalName}`}
              >
                🗑
              </button>
            )}
            <div className="flex h-36 items-center justify-center bg-stone-50">
              {r.mimeType === "application/pdf" ? (
                <div className="text-center text-stone-400">
                  <div className="text-4xl">📄</div>
                  <div className="text-xs font-semibold">PDF</div>
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/receipts/${r.id}/file`}
                  alt={r.originalName}
                  className="h-full w-full object-cover"
                />
              )}
            </div>
            <div className="space-y-1 p-2">
              <div className="truncate text-xs font-medium">{r.originalName}</div>
              {onSaveNote ? (
                <input
                  key={`note-${r.id}-${r.note}`}
                  className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] text-stone-600 placeholder:italic hover:border-stone-200 focus:border-stone-300 focus:outline-none"
                  defaultValue={r.note}
                  placeholder="Add description…"
                  maxLength={300}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v !== r.note) onSaveNote(r.id, v);
                  }}
                  aria-label={`Description for ${r.originalName}`}
                  data-testid={`receipt-note-${r.id}`}
                />
              ) : (
                r.note && <div className="truncate text-[11px] text-stone-600">{r.note}</div>
              )}
              <div className="text-[11px] text-stone-400">
                {new Date(r.createdAt).toLocaleDateString()} · {(r.sizeBytes / 1024).toFixed(0)} KB
                {r.status !== "unassigned" && " · processed"}
              </div>
              {r.claims.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {r.claims.map((c) => (
                    <Link
                      key={c.id}
                      href={`/claims/${c.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] text-indigo-700 hover:bg-indigo-100"
                      data-testid={`claim-link-${r.id}-${c.id}`}
                    >
                      {c.status === "draft" ? "Draft" : "Claim"} {new Date(c.createdAt).toLocaleDateString()}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
