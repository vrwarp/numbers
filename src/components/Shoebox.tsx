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

// NDJSON progress lines streamed by POST /api/reimbursements (see the route).
type StreamMessage =
  | { type: "status"; phase: "extracting"; total: number }
  | { type: "receipt-done"; receiptId: string; receiptName: string; ok: boolean; completed: number; total: number }
  | { type: "quota-wait"; receiptId: string; receiptName: string; attempt: number; maxRetries: number; cooldownMs: number; message: string }
  | { type: "done"; reimbursementId: string }
  | { type: "error"; status: number; message: string };

export default function Shoebox() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploadNote, setUploadNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/receipts");
    if (res.ok) setReceipts((await res.json()).receipts);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function onFilesPicked(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("files", f);
      if (uploadNote.trim()) form.append("note", uploadNote.trim());
      const res = await fetch("/api/receipts", { method: "POST", body: form });
      if (!res.ok) throw new Error((await res.json()).error ?? "Upload failed");
      setUploadNote("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
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

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let claimId: string | null = null;

      const handle = (ev: StreamMessage) => {
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
            setStatus(ev.message);
            break;
          case "done":
            claimId = ev.reimbursementId;
            break;
          case "error":
            throw new Error(ev.message);
        }
      };

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) handle(JSON.parse(line) as StreamMessage);
        }
      }
      const tail = buffer.trim();
      if (tail) handle(JSON.parse(tail) as StreamMessage);

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
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/*,application/pdf"
            multiple
            className="hidden"
            data-testid="file-input"
            onChange={(e) => onFilesPicked(e.target.files)}
          />
          <input
            className="input w-56"
            placeholder="Optional description…"
            value={uploadNote}
            onChange={(e) => setUploadNote(e.target.value)}
            maxLength={300}
            aria-label="Optional description for this upload"
            data-testid="upload-note"
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
        <div className="card sticky top-16 z-30 border-indigo-200 bg-indigo-50 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-indigo-900">
              {selected.size} receipt{selected.size > 1 ? "s" : ""} selected
            </span>
            <button className="btn-primary" onClick={generateClaim} disabled={generating} data-testid="generate-claim">
              {generating ? (waiting ? "Waiting on rate limit…" : "Reading receipts…") : "✨ Generate Claim"}
            </button>
          </div>
          {generating && status && (
            <p
              className={`mt-2 text-xs ${waiting ? "font-medium text-amber-700" : "text-indigo-700"}`}
              role="status"
              aria-live="polite"
              data-testid="generate-status"
            >
              {waiting ? "⏳ " : ""}
              {status}
            </p>
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
