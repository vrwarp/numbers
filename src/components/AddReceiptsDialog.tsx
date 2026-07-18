"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import ReceiptGrid, { type ReceiptSummary } from "./ReceiptGrid";
import { readNdjsonStream } from "@/lib/ndjson";
import type { ClaimStreamMessage } from "@/lib/claim-stream";
import { useApiErrorMessage } from "@/lib/use-api-error";

/**
 * Modal for adding receipts to an existing draft claim: pick from the Shoebox
 * (receipts already on this claim are hidden) or upload new files right here,
 * then POST the selection to /api/reimbursements/[id]/receipts with streamed
 * extraction progress.
 */
export default function AddReceiptsDialog({
  claimId,
  excludeReceiptIds,
  onClose,
  onAdded,
}: {
  claimId: string;
  /** Receipts already on the claim — not offered again. */
  excludeReceiptIds: string[];
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const t = useTranslations("AddReceipts");
  const tCommon = useTranslations("Common");
  const tErrors = useTranslations("Errors");
  const apiError = useApiErrorMessage();
  const fileInput = useRef<HTMLInputElement>(null);
  const [receipts, setReceipts] = useState<ReceiptSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Aborts the in-flight extraction stream when the user bails to manual entry.
  const addAbort = useRef<AbortController | null>(null);
  const bailingToManual = useRef(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/receipts");
    if (!res.ok) {
      setError(apiError(await res.json().catch(() => null), t("loadFailed")));
      return;
    }
    setReceipts((await res.json()).receipts);
  }, [apiError, t]);

  useEffect(() => {
    load();
  }, [load]);

  // Filter at render time so the fetch doesn't re-run when the parent re-renders
  // (excludeReceiptIds is a fresh array each time).
  const offered = receipts?.filter((r) => !excludeReceiptIds.includes(r.id)) ?? null;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onFilesPicked(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("files", f);
      const res = await fetch("/api/receipts", { method: "POST", body: form });
      if (!res.ok) throw new Error(apiError(await res.json().catch(() => null), t("uploadFailed")));
      const { receipts: created } = await res.json();
      await load();
      // A receipt uploaded from here is obviously meant for this claim.
      setSelected((prev) => {
        const next = new Set(prev);
        for (const r of created as ReceiptSummary[]) next.add(r.id);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("uploadFailed"));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  // Skip AI extraction and add the receipts as blank rows to fill in later —
  // the escape hatch when the provider is rate-limited. Aborts the running
  // stream first so it stops waiting out the cooldown.
  async function addManually() {
    bailingToManual.current = true;
    addAbort.current?.abort();
    setWaiting(false);
    setStatus(t("addingManual"));
    try {
      const res = await fetch(`/api/reimbursements/${claimId}/receipts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptIds: Array.from(selected), manual: true }),
      });
      if (!res.ok) throw new Error(apiError(await res.json().catch(() => null), t("addFailed")));
      await onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("addFailed"));
      setAdding(false);
      setStatus(null);
    }
  }

  async function addToClaim() {
    setAdding(true);
    setError(null);
    setStatus(t("readingInitial"));
    bailingToManual.current = false;
    const abort = new AbortController();
    addAbort.current = abort;
    try {
      const res = await fetch(`/api/reimbursements/${claimId}/receipts`, {
        method: "POST",
        // Ask for streamed progress so quota waits show up live.
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({ receiptIds: Array.from(selected) }),
        signal: abort.signal,
      });
      // A pre-stream failure (auth/validation) comes back as plain JSON.
      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => ({}));
        throw new Error(apiError(json, t("addFailed")));
      }

      let ok = false;
      await readNdjsonStream<ClaimStreamMessage>(res.body, (ev) => {
        switch (ev.type) {
          case "status":
            setWaiting(false);
            setStatus(t("readingCount", { total: ev.total }));
            break;
          case "receipt-done":
            setWaiting(false);
            setStatus(t("readProgress", { completed: ev.completed, total: ev.total }));
            break;
          case "quota-wait":
            setWaiting(true);
            setStatus(
              tErrors("quotaWait", {
                seconds: Math.round(ev.cooldownMs / 1000),
                attempt: ev.attempt,
                maxRetries: ev.maxRetries,
              })
            );
            break;
          case "done":
            ok = true;
            break;
          case "error":
            throw new Error(apiError(ev, t("addFailed")));
        }
      });

      if (!ok) throw new Error(t("endedUnexpectedly"));
      await onAdded();
    } catch (e) {
      // The user bailed to manual entry — addManually now owns the UI.
      if (bailingToManual.current) return;
      setError(e instanceof Error ? e.message : t("addFailed"));
      setAdding(false);
      setStatus(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal
      data-testid="add-receipts-dialog"
    >
      <div className="card flex max-h-[85dvh] w-full max-w-3xl flex-col p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-bold">{t("title")}</h2>
            <p className="text-sm text-stone-500">{t("intro")}</p>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/*,application/pdf"
            multiple
            className="hidden"
            data-testid="add-receipts-file-input"
            onChange={(e) => onFilesPicked(e.target.files)}
          />
          <button
            className="btn-secondary"
            onClick={() => fileInput.current?.click()}
            disabled={uploading || adding}
            data-testid="add-receipts-upload"
          >
            {uploading ? t("uploading") : t("upload")}
          </button>
        </div>

        {error && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
            {error}
          </div>
        )}

        <div className="mt-4 min-h-24 flex-1 overflow-y-auto">
          {offered === null ? (
            <p className="text-sm text-stone-500">{tCommon("loading")}</p>
          ) : offered.length === 0 ? (
            <div className="card p-8 text-center text-stone-500">
              <p className="font-medium">{t("emptyTitle")}</p>
              <p className="text-sm">{t("emptyBody")}</p>
            </div>
          ) : (
            <ReceiptGrid receipts={offered} selectable selected={selected} onToggle={toggle} />
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          {adding && status && (
            <span
              className={`mr-auto text-xs ${waiting ? "font-medium text-amber-700" : "text-indigo-700"}`}
              role="status"
              aria-live="polite"
              data-testid="add-receipts-status"
            >
              {status}
              {waiting && (
                <button
                  className="ml-2 rounded px-1.5 py-0.5 font-semibold text-amber-800 underline underline-offset-2 hover:bg-amber-100"
                  onClick={addManually}
                  data-testid="add-receipts-manual"
                >
                  {t("manualInstead")}
                </button>
              )}
            </span>
          )}
          <button
            className="btn-secondary"
            onClick={onClose}
            disabled={adding}
            data-testid="add-receipts-cancel"
          >
            {tCommon("cancel")}
          </button>
          <button
            className="btn-primary"
            onClick={addToClaim}
            disabled={adding || selected.size === 0}
            data-testid="add-receipts-confirm"
          >
            {adding
              ? t("confirmReading")
              : selected.size > 0
                ? t("confirmCount", { count: selected.size })
                : t("confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
