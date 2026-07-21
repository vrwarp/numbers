"use client";

/**
 * Device-fleet UI (docs/MULTI_DEVICE_PLAN.md M2–M4), written for the same
 * non-technical audience as the rest of e-sign: plain words, one obvious
 * action per state, cryptography behind the scenes.
 *
 * - NewDeviceCard: this browser isn't authorized for an existing identity —
 *   silent passkey already failed by the time this renders. Paths in
 *   priority order: approve-from-other-device (6-digit code), recovery
 *   phrase, and a deliberately buried start-over.
 * - DevicesPanel: the member's authorized devices, with remove (AMK
 *   rotation) and lost-device guidance.
 * - RecoveryCard: one-time 24-word phrase setup with word-confirmation;
 *   sticky (non-dismissible) for the root, whose key anchors everyone.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useDateLabel } from "@/lib/use-date-label";
import {
  approveDevice,
  currentDeviceId,
  recoverWithPhrase,
  recoveryOverview,
  rejectDevice,
  removeDevice,
  requestAuthorization,
  setupPhrase,
  startOver,
  watchAuthorization,
  watchAuthorizedDevices,
  type AuthorizedDevice,
  type DeviceEnv,
  type PendingDeviceRequest,
} from "@/lib/esign/devices";
import { useThrownErrorMessage } from "@/lib/use-api-error";
import { useModalDismiss } from "@/lib/use-modal-dismiss";
import { deliverPdf } from "@/lib/pdf-delivery";
import ConfirmDialog from "@/components/ConfirmDialog";

// --- M2: the new-device gate ---------------------------------------------------

export function NewDeviceCard({
  env,
  fleetGone,
  onReady,
  onStartOver,
}: {
  env: DeviceEnv;
  /** True when the account-keys document is gone entirely (post start-over). */
  fleetGone: boolean;
  onReady: () => Promise<void> | void;
  onStartOver: () => void;
}) {
  const t = useTranslations("Devices");
  const tCommon = useTranslations("Common");
  const thrown = useThrownErrorMessage();
  const [mode, setMode] = useState<"idle" | "waiting" | "phrase">("idle");
  const [code, setCode] = useState<string | null>(null);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startOverOpen, setStartOverOpen] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => () => unsubRef.current?.(), []);

  async function beginRequest() {
    setBusy(true);
    setError(null);
    try {
      const c = await requestAuthorization(env);
      setCode(c);
      setMode("waiting");
      unsubRef.current = await watchAuthorization(env, () => {
        unsubRef.current?.();
        void onReady();
      });
    } catch (err) {
      setError(thrown(err, t("couldNotStart")));
    } finally {
      setBusy(false);
    }
  }

  async function submitPhrase() {
    setBusy(true);
    setError(null);
    try {
      await recoverWithPhrase(env, phrase);
      await onReady();
    } catch {
      setError(t("phraseWrong"));
      setBusy(false);
    }
  }

  // Confirms through ConfirmDialog, not window.confirm() — iOS suppresses
  // native dialogs in home-screen (standalone) web apps.
  async function doStartOver() {
    setStartOverOpen(false);
    setBusy(true);
    setError(null);
    try {
      await startOver(env);
      onStartOver();
    } catch (err) {
      setError(thrown(err, t("couldNotReset")));
      setBusy(false);
    }
  }

  if (mode === "waiting" && code) {
    return (
      <div className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4" data-testid="waiting-approval">
        <p className="text-sm font-medium text-indigo-900">{t("waitingIntro")}</p>
        <div
          className="mx-auto w-fit rounded-xl bg-white px-6 py-3 font-mono text-3xl font-bold tracking-[0.3em] text-indigo-900 shadow-sm"
          data-testid="device-code"
        >
          {code}
        </div>
        <p className="text-xs text-indigo-800/70">
          {t("waitingNote")}
        </p>
        {/* Codes expire, subscriptions can drop — without an exit this screen
            could hold the member hostage until a full reload. Cancel stops the
            watch and returns to the options; a fresh attempt mints a new code. */}
        <button
          className="text-xs font-medium text-indigo-700 underline underline-offset-2"
          onClick={() => {
            unsubRef.current?.();
            unsubRef.current = null;
            setCode(null);
            setMode("idle");
          }}
          data-testid="waiting-cancel"
        >
          {t("waitingCancel")}
        </button>
      </div>
    );
  }

  if (mode === "phrase") {
    return (
      <div className="space-y-3 rounded-xl border border-stone-200 bg-stone-50 p-4">
        <p className="text-sm font-medium">{t("phraseTitle")}</p>
        <textarea
          className="input h-28 w-full font-mono text-sm"
          placeholder={t("phrasePlaceholder")}
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          data-testid="recover-phrase-input"
        />
        {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => setMode("idle")}>
            {tCommon("back")}
          </button>
          <button
            className="btn-primary disabled:opacity-50"
            disabled={busy || phrase.trim().split(/\s+/).length < 24}
            onClick={submitPhrase}
            data-testid="recover-phrase-submit"
          >
            {busy ? t("unlocking") : t("unlock")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="new-device-card">
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">{t("newDeviceTitle")}</p>
        <p className="mt-1">{fleetGone ? t("newDeviceBodyGone") : t("newDeviceBody")}</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {!fleetGone ? (
        <div className="grid gap-2">
          <button className="btn-primary" onClick={beginRequest} disabled={busy} data-testid="request-device-auth">
            {t("approveFromOther")}
          </button>
          <button
            className="btn-secondary"
            onClick={() => setMode("phrase")}
            disabled={busy}
            data-testid="recover-phrase-option"
          >
            {t("typePhraseOption")}
          </button>
        </div>
      ) : (
        <p className="text-sm text-stone-600">{t("keysRemovedEverywhere")}</p>
      )}
      <details className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600">
        <summary className="cursor-pointer select-none font-medium text-stone-500">
          {t("noneWork")}
        </summary>
        <p className="mt-2">{t("noneWorkBody")}</p>
        <button
          className="btn-secondary mt-2"
          onClick={() => setStartOverOpen(true)}
          disabled={busy}
          data-testid="start-over"
        >
          {t("startOver")}
        </button>
      </details>
      <ConfirmDialog
        open={startOverOpen}
        message={t("startOverConfirm")}
        confirmLabel={t("startOverConfirmButton")}
        busy={busy}
        onConfirm={doStartOver}
        onCancel={() => setStartOverOpen(false)}
        testId="start-over-confirm"
      />
    </div>
  );
}

// --- M3: pending-request approval prompt (shared by banner + profile) -------------

export function PendingRequestPrompt({
  env,
  request,
  onSettled,
}: {
  env: DeviceEnv;
  request: PendingDeviceRequest;
  onSettled: () => void;
}) {
  const t = useTranslations("Devices");
  const thrown = useThrownErrorMessage();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await approveDevice(env, request, typed);
      onSettled();
    } catch (err) {
      setError(thrown(err, t("approvalFailed")));
      // Clean slate for the retry — a wrong (or expired) code should not
      // linger in the field looking half-entered.
      setTyped("");
      setBusy(false);
    }
  }

  return (
    <div
      className="rounded-xl border-2 border-indigo-200 bg-indigo-50 p-4"
      data-testid="device-request-banner"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-48 flex-1 text-sm text-indigo-900">
          <p className="font-semibold">
            {t("deviceWants", { name: request.decryptedDeviceName || t("unnamedDevice") })}
          </p>
          <p className="mt-0.5 text-xs text-indigo-800/70">
            {t.rich("approveHint", { em: (chunks) => <em>{chunks}</em> })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            className="input w-28 text-center font-mono text-lg tracking-widest"
            inputMode="numeric"
            maxLength={6}
            placeholder="000000"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            data-testid="device-code-input"
          />
          <button
            className="btn-primary disabled:opacity-50"
            disabled={busy || typed.replace(/\D/g, "").length !== 6}
            onClick={approve}
            data-testid="approve-device"
          >
            {busy ? "…" : t("approve")}
          </button>
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await rejectDevice(env, request.deviceId);
                onSettled();
              } catch (err) {
                // Swallowing this made a still-pending request LOOK denied —
                // for a security prompt that's the wrong direction to fail.
                setError(thrown(err, t("rejectFailed")));
                setBusy(false);
              }
            }}
            data-testid="reject-device"
          >
            {t("rejectDevice")}
          </button>
        </div>
      </div>
      {error && <p className="mt-2 rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}

// --- M3: authorized devices panel ---------------------------------------------

export function DevicesPanel({ env }: { env: DeviceEnv }) {
  const t = useTranslations("Devices");
  const dateLabel = useDateLabel();
  const thrown = useThrownErrorMessage();
  const [devices, setDevices] = useState<AuthorizedDevice[]>([]);
  const [selfId, setSelfId] = useState<string>("");
  const [busyId, setBusyId] = useState<string | null>(null);
  // Device awaiting sign-out confirmation via ConfirmDialog (iOS home-screen
  // apps suppress window.confirm — see ConfirmDialog).
  const [removing, setRemoving] = useState<AuthorizedDevice | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      setSelfId(await currentDeviceId(env));
      const u = await watchAuthorizedDevices(env, setDevices);
      if (cancelled) u();
      else unsub = u;
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.me.userId]);

  async function doRemove(device: AuthorizedDevice) {
    setRemoving(null);
    setBusyId(device.deviceId);
    setError(null);
    try {
      await removeDevice(env, device.deviceId);
    } catch (err) {
      setError(thrown(err, t("couldNotRemove")));
    } finally {
      setBusyId(null);
    }
  }

  if (devices.length === 0) return null;

  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 p-3" data-testid="devices-panel">
      <p className="text-xs font-medium text-stone-500">{t("devicesTitle")}</p>
      <ul className="mt-2 space-y-2">
        {devices.map((d) => (
          <li key={d.deviceId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {d.decryptedDeviceName || t("unnamedDevice")}
              {d.deviceId === selfId && (
                <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                  {t("thisDevice")}
                </span>
              )}
              <span className="ml-2 text-xs text-stone-400">
                {t("addedOn", {
                  date: dateLabel(d.createdAt),
                })}
              </span>
            </span>
            {d.deviceId !== selfId && (
              <button
                className="rounded-lg border border-red-200 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
                disabled={busyId === d.deviceId}
                onClick={() => setRemoving(d)}
                data-testid={`remove-device-${d.deviceId}`}
              >
                {busyId === d.deviceId ? "…" : t("removeDevice")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <p className="mt-2 text-xs text-stone-400">{t("lostHint")}</p>
      <ConfirmDialog
        open={removing !== null}
        message={removing ? t("removeConfirm", { name: removing.decryptedDeviceName }) : ""}
        confirmLabel={t("removeConfirmButton")}
        busy={busyId !== null}
        onConfirm={() => removing && doRemove(removing)}
        onCancel={() => setRemoving(null)}
        testId="remove-device-confirm"
      />
    </div>
  );
}

// --- M4: recovery phrase setup (print-first) -------------------------------------

export function RecoveryCard({ env, sticky }: { env: DeviceEnv; sticky: boolean }) {
  const t = useTranslations("Devices");
  const [state, setState] = useState<"loading" | "needed" | "done" | "dismissed">("loading");
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const overview = await recoveryOverview(env);
      if (overview.hasPhrase) setState("done");
      else if (!sticky && localStorage.getItem("numbers-esign-recovery-later") === "1")
        setState("dismissed");
      else setState("needed");
    } catch {
      setState("dismissed");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.me.userId, sticky]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state !== "needed") return null;

  return (
    <div
      className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4"
      data-testid="recovery-nudge"
    >
      <p className="text-sm font-medium text-amber-900">
        {sticky ? t("recoveryRoot") : t("recoveryNudge")}
      </p>
      <div className="flex gap-2">
        <button className="btn-primary" onClick={() => setDialogOpen(true)} data-testid="setup-phrase">
          {t("printSheet")}
        </button>
        {!sticky && (
          <button
            className="btn-secondary"
            onClick={() => {
              localStorage.setItem("numbers-esign-recovery-later", "1");
              setState("dismissed");
            }}
          >
            {t("later")}
          </button>
        )}
      </div>
      {dialogOpen && (
        <PhraseDialog
          env={env}
          onClose={() => setDialogOpen(false)}
          onDone={async () => {
            setDialogOpen(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

function PhraseDialog({
  env,
  onClose,
  onDone,
}: {
  env: DeviceEnv;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const t = useTranslations("Devices");
  const tCommon = useTranslations("Common");
  const thrown = useThrownErrorMessage();
  const [words, setWords] = useState<string[] | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDismiss(dialogRef, onClose);

  useEffect(() => {
    // charproof registers the phrase as it mints it; reopening the dialog
    // replaces it wholesale, so a cancelled/unprinted phrase is never the
    // only copy the member is relying on.
    void setupPhrase(env)
      .then((mnemonic) => setWords(mnemonic.split(" ")))
      .catch((err) => setError(thrown(err, t("couldNotCreatePhrase"))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function downloadSheet() {
    if (!words) return;
    setError(null);
    try {
      // Built in THIS browser — the words never touch the server.
      const { buildRecoverySheetPdf } = await import("@/lib/esign/recovery-sheet");
      const bytes = await buildRecoverySheetPdf({
        words,
        name: env.me.name,
        email: env.me.email,
      });
      const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
      // Standalone PWA: a.download silently no-ops, so the share sheet
      // delivers instead (Save to Files / Print / AirDrop). No server GET can
      // exist for this file — the words never touch the server — so a second
      // tap of the same button re-shares if activation was already spent.
      if (await deliverPdf(blob, "signing-recovery-sheet.pdf")) {
        setDownloaded(true);
      }
    } catch (err) {
      setError(thrown(err, t("couldNotBuildSheet")));
    }
  }

  return (
    <div ref={dialogRef} className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" role="dialog" aria-modal>
      <div className="max-h-[92dvh] w-full max-w-lg space-y-4 overflow-y-auto overscroll-contain rounded-t-2xl bg-white p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:rounded-2xl sm:pb-6">
        <h3 className="text-lg font-bold">{t("phraseDialogTitle")}</h3>
        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {!words ? (
          <p className="text-sm text-stone-500">{t("preparing")}</p>
        ) : (
          <>
            <p className="text-sm text-stone-600">{t("sheetBody")}</p>
            {/* Every open of this dialog mints a FRESH phrase — a sheet from a
                previous open no longer works. Say so, or a member who reopens
                "just to double-check" silently invalidates their printout. */}
            <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{t("freshPhraseNote")}</p>
            <button className="btn-primary w-full" onClick={downloadSheet} data-testid="download-recovery-pdf">
              {downloaded ? t("downloadedPrint") : t("downloadSheet")}
            </button>
            <details className="rounded-lg bg-stone-50 p-3 text-xs text-stone-600">
              <summary className="cursor-pointer select-none font-medium">
                {t("noPrinter")}
              </summary>
              <ol
                className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm sm:grid-cols-3"
                data-testid="phrase-words"
              >
                {words.map((w, i) => (
                  <li key={i} className="tabular-nums">
                    <span className="mr-1 text-stone-400">{i + 1}.</span>
                    {w}
                  </li>
                ))}
              </ol>
            </details>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={saved}
                onChange={(e) => setSaved(e.target.checked)}
                data-testid="recovery-saved-checkbox"
              />
              <span>{t("savedCheckbox")}</span>
            </label>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={onClose}>
                {tCommon("cancel")}
              </button>
              <button
                className="btn-primary disabled:opacity-50"
                disabled={!saved}
                onClick={() => void onDone()}
                data-testid="phrase-done"
              >
                {t("done")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
