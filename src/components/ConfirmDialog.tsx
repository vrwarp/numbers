"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { useModalDismiss } from "@/lib/use-modal-dismiss";

/**
 * In-app replacement for window.confirm(). iOS suppresses native JS dialogs in
 * home-screen (standalone display-mode) web apps — confirm() renders nothing
 * and returns false — so any destructive action gated on it silently no-ops on
 * an installed iPhone app. Confirm through DOM UI instead.
 */
export default function ConfirmDialog({
  open,
  message,
  confirmLabel,
  busy = false,
  tone = "danger",
  errorText = null,
  onConfirm,
  onCancel,
  testId = "confirm-dialog",
}: {
  open: boolean;
  message: string;
  /** Label for the destructive action button (e.g. "Delete"). */
  confirmLabel: string;
  /** Disables both buttons while the confirmed action is in flight. */
  busy?: boolean;
  /** "danger" (default) for destructive confirms; "primary" for benign ones —
   *  a red button on a safe action overstates the stakes. */
  tone?: "danger" | "primary";
  /** Failure feedback shown inside the dialog — a confirm that closes on
   *  error is indistinguishable from success. */
  errorText?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  const tCommon = useTranslations("Common");
  const dialogRef = useRef<HTMLDivElement>(null);
  // Escape = Cancel (unless the action is already in flight); Tab stays inside.
  useModalDismiss(dialogRef, () => {
    if (!busy) onCancel();
  }, open);
  if (!open) return null;
  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="alertdialog"
      aria-modal
      aria-label={message}
    >
      <div className="card w-full max-w-sm p-6" data-testid={testId}>
        <p className="whitespace-pre-line text-sm">{message}</p>
        {errorText && (
          <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">
            {errorText}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="btn-secondary"
            onClick={onCancel}
            disabled={busy}
            data-testid={`${testId}-cancel`}
          >
            {tCommon("cancel")}
          </button>
          <button
            className={tone === "danger" ? "btn-danger" : "btn-primary"}
            onClick={onConfirm}
            disabled={busy}
            data-testid={`${testId}-confirm`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
