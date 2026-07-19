"use client";

import { useRef, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useModalDismiss } from "@/lib/use-modal-dismiss";

/**
 * Bottom-sheet-on-mobile / centered-on-desktop confirm modal (matches the
 * submit ceremony's chrome), used for role changes, key revocation, and the
 * irreversible reject decision. Pass `danger` for destructive confirmations.
 */
export default function ConfirmDialog({
  title,
  confirmLabel,
  danger = false,
  busy = false,
  error,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const tCommon = useTranslations("Common");
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDismiss(dialogRef, () => {
    if (!busy) onCancel();
  });
  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[92dvh] w-full max-w-md space-y-4 overflow-y-auto overscroll-contain rounded-t-2xl bg-white p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:rounded-2xl sm:pb-6">
        <h3 className="text-lg font-bold">{title}</h3>
        <div className="space-y-2 text-sm text-stone-600">{children}</div>
        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            {tCommon("cancel")}
          </button>
          <button
            className={danger ? "btn-danger" : "btn-primary"}
            onClick={onConfirm}
            disabled={busy}
            data-testid="confirm-dialog-submit"
          >
            {busy ? "…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
