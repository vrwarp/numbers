"use client";

import { useTranslations } from "next-intl";

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
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  const tCommon = useTranslations("Common");
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="alertdialog"
      aria-modal
      aria-label={message}
    >
      <div className="card w-full max-w-sm p-6" data-testid={testId}>
        <p className="text-sm">{message}</p>
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
            className="btn-danger"
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
