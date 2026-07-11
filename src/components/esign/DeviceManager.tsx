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
  const [mode, setMode] = useState<"idle" | "waiting" | "phrase">("idle");
  const [code, setCode] = useState<string | null>(null);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      setError(err instanceof Error ? err.message : "Could not start");
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
      setError("That phrase didn't work — check the words and their order");
      setBusy(false);
    }
  }

  async function doStartOver() {
    if (
      !confirm(
        "Start over from nothing?\n\nThis signs ALL your devices out of electronic signing and throws away your current signing key. You'll set up again from scratch and be vouched for again in person — being vouched back in automatically retires the old key. Anything you already signed stays valid."
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await startOver(env);
      onStartOver();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset");
      setBusy(false);
    }
  }

  if (mode === "waiting" && code) {
    return (
      <div className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4" data-testid="waiting-approval">
        <p className="text-sm font-medium text-indigo-900">
          Now pick up the device you already sign with. A message appears there — type this
          code into it:
        </p>
        <div
          className="mx-auto w-fit rounded-xl bg-white px-6 py-3 font-mono text-3xl font-bold tracking-[0.3em] text-indigo-900 shadow-sm"
          data-testid="device-code"
        >
          {code}
        </div>
        <p className="text-xs text-indigo-800/70">
          Waiting for the other device… this page continues by itself once it&apos;s approved.
          The code proves the other device is talking to <em>this</em> browser and not an
          impostor.
        </p>
      </div>
    );
  }

  if (mode === "phrase") {
    return (
      <div className="space-y-3 rounded-xl border border-stone-200 bg-stone-50 p-4">
        <p className="text-sm font-medium">Type your 24-word recovery phrase</p>
        <textarea
          className="input h-28 w-full font-mono text-sm"
          placeholder="correct horse battery staple …"
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          data-testid="recover-phrase-input"
        />
        {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => setMode("idle")}>
            Back
          </button>
          <button
            className="btn-primary disabled:opacity-50"
            disabled={busy || phrase.trim().split(/\s+/).length < 24}
            onClick={submitPhrase}
            data-testid="recover-phrase-submit"
          >
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="new-device-card">
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">This looks like a new device.</p>
        <p className="mt-1">
          Your signing identity exists, but it isn&apos;t on this{" "}
          {fleetGone ? "account anymore" : "device yet"}. Bring it over — no re-vouching
          needed{fleetGone ? " unless you start over" : ""}.
        </p>
      </div>
      {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {!fleetGone ? (
        <div className="grid gap-2">
          <button className="btn-primary" onClick={beginRequest} disabled={busy} data-testid="request-device-auth">
            📱 Approve from a device you already sign with
          </button>
          <button
            className="btn-secondary"
            onClick={() => setMode("phrase")}
            disabled={busy}
            data-testid="recover-phrase-option"
          >
            🔑 Type my 24-word recovery phrase
          </button>
        </div>
      ) : (
        <p className="text-sm text-stone-600">
          Your signing keys were removed everywhere, so the only way forward is to start
          over below.
        </p>
      )}
      <details className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600">
        <summary className="cursor-pointer select-none font-medium text-stone-500">
          None of these work?
        </summary>
        <p className="mt-2">
          If your old devices are gone and you never printed a recovery sheet, the identity
          can&apos;t be recovered — that&apos;s what keeps it yours. Starting over creates a
          brand-new signing key: the same people who vouched for you before vouch for you
          again, and the moment they do, your old key stops counting automatically. Only if
          you think someone else might USE the old key before then, tell your administrator —
          they can retire it immediately.
        </p>
        <button className="btn-secondary mt-2" onClick={doStartOver} disabled={busy} data-testid="start-over">
          Start over from nothing
        </button>
      </details>
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
      setError(err instanceof Error ? err.message : "Approval failed");
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
            “{request.decryptedDeviceName || "A new device"}” wants to sign as you.
          </p>
          <p className="mt-0.5 text-xs text-indigo-800/70">
            Only approve if it&apos;s yours and in your hands. Type the 6-digit code from{" "}
            <em>its</em> screen — that&apos;s what proves it&apos;s really that device.
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
            {busy ? "…" : "Approve"}
          </button>
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={async () => {
              await rejectDevice(env, request.deviceId).catch(() => {});
              onSettled();
            }}
            data-testid="reject-device"
          >
            Reject
          </button>
        </div>
      </div>
      {error && <p className="mt-2 rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}

// --- M3: authorized devices panel ---------------------------------------------

export function DevicesPanel({ env }: { env: DeviceEnv }) {
  const [devices, setDevices] = useState<AuthorizedDevice[]>([]);
  const [selfId, setSelfId] = useState<string>("");
  const [busyId, setBusyId] = useState<string | null>(null);
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

  async function remove(device: AuthorizedDevice) {
    if (
      !confirm(
        `Sign “${device.decryptedDeviceName}” out of electronic signing?\n\nIt loses access immediately (your keys rotate under the hood). If the device might be in someone else's hands, also tell your administrator in person so they can revoke your signing key.`
      )
    ) {
      return;
    }
    setBusyId(device.deviceId);
    setError(null);
    try {
      await removeDevice(env, device.deviceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the device");
    } finally {
      setBusyId(null);
    }
  }

  if (devices.length === 0) return null;

  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 p-3" data-testid="devices-panel">
      <p className="text-xs font-medium text-stone-500">Devices that can sign as you</p>
      <ul className="mt-2 space-y-2">
        {devices.map((d) => (
          <li key={d.deviceId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {d.decryptedDeviceName || "Unnamed device"}
              {d.deviceId === selfId && (
                <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                  this device
                </span>
              )}
              <span className="ml-2 text-xs text-stone-400">
                added {new Date(d.createdAt).toLocaleDateString()}
              </span>
            </span>
            {d.deviceId !== selfId && (
              <button
                className="rounded-lg border border-red-200 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
                disabled={busyId === d.deviceId}
                onClick={() => remove(d)}
                data-testid={`remove-device-${d.deviceId}`}
              >
                {busyId === d.deviceId ? "…" : "remove"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <p className="mt-2 text-xs text-stone-400">
        Lost one? Remove it here, then tell your administrator in person if someone else
        might have it — they can revoke the signing key itself.
      </p>
    </div>
  );
}

// --- M4: recovery phrase setup (print-first) -------------------------------------

export function RecoveryCard({ env, sticky }: { env: DeviceEnv; sticky: boolean }) {
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
        {sticky
          ? "Protect the church's signing anchor. If this device is lost with no recovery sheet, electronic signing has to be rebuilt from scratch for everyone."
          : "One more safety net: print a recovery sheet and you can sign from a new device even if this one is lost."}
      </p>
      <div className="flex gap-2">
        <button className="btn-primary" onClick={() => setDialogOpen(true)} data-testid="setup-phrase">
          Print my recovery sheet
        </button>
        {!sticky && (
          <button
            className="btn-secondary"
            onClick={() => {
              localStorage.setItem("numbers-esign-recovery-later", "1");
              setState("dismissed");
            }}
          >
            Later
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
  const [words, setWords] = useState<string[] | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // charproof registers the phrase as it mints it; reopening the dialog
    // replaces it wholesale, so a cancelled/unprinted phrase is never the
    // only copy the member is relying on.
    void setupPhrase(env)
      .then((mnemonic) => setWords(mnemonic.split(" ")))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not create a phrase"));
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
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "signing-recovery-sheet.pdf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setDownloaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the sheet");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" role="dialog">
      <div className="max-h-[92vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-2xl bg-white p-6 sm:rounded-2xl">
        <h3 className="text-lg font-bold">Print your recovery sheet</h3>
        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {!words ? (
          <p className="text-sm text-stone-500">Preparing…</p>
        ) : (
          <>
            <p className="text-sm text-stone-600">
              This one-page sheet holds the 24 words that can bring your signing identity to a
              new device. Print it and keep it with your important papers at home. Anyone
              holding the sheet can sign as you — and nobody, including the church, can
              recreate it if it&apos;s lost.
            </p>
            <button className="btn-primary w-full" onClick={downloadSheet} data-testid="download-recovery-pdf">
              {downloaded ? "✓ Downloaded — print it now" : "🖨️ Download the sheet to print (PDF)"}
            </button>
            <details className="rounded-lg bg-stone-50 p-3 text-xs text-stone-600">
              <summary className="cursor-pointer select-none font-medium">
                No printer? Copy the words by hand
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
              <span>The sheet is printed (or written out) and stored somewhere safe.</span>
            </label>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn-primary disabled:opacity-50"
                disabled={!saved}
                onClick={() => void onDone()}
                data-testid="phrase-done"
              >
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
