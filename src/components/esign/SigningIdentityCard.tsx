"use client";

/**
 * Profile-page card for the member's signing identity
 * (docs/ESIGN_DESIGN.md §4.2–4.3). Written for non-technical members: the
 * happy path is "agree → sign your name → show the code to two people".
 * Fingerprints and other audit material live behind a details disclosure.
 * The QR encodes a /vouch URL so a voucher scans it with their phone's
 * native camera — no in-app decoder.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  bootstrapRegistry,
  custodyFor,
  enroll,
  loadEnv,
  loadRoster,
  repairEnrollment,
  reportRoster,
  updateSignatureImage,
  type EsignEnv,
} from "@/lib/esign/client";
import type { DeviceStatus } from "@/lib/esign/custody";
import { fingerprintDisplay, keyFingerprint } from "@/lib/esign/canonical";
import { CONSENT_TEXT } from "@/lib/esign/consent";
import { useThrownErrorMessage } from "@/lib/use-api-error";
import AllowlistPanel from "./AllowlistPanel";
import { DevicesPanel, NewDeviceCard, RecoveryCard } from "./DeviceManager";
import IdentityQr from "./IdentityQr";
import SignaturePad from "./SignaturePad";

export default function SigningIdentityCard() {
  const t = useTranslations("Identity");
  const tEsign = useTranslations("Esign");
  const tRole = useTranslations("Common.role");
  const thrown = useThrownErrorMessage();
  const [env, setEnv] = useState<EsignEnv | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [redrawOpen, setRedrawOpen] = useState(false);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      let loaded = await loadEnv();
      setEnv(loaded);
      if (loaded.me.publicKey) setFingerprint(await keyFingerprint(loaded.me.publicKey));
      // Where does this browser stand in the member's device fleet (M2)?
      if (loaded.bootstrapped && loaded.enabled && loaded.me.identityStatus) {
        const device = await custodyFor(loaded).deviceStatus();
        setDeviceStatus(device);
        // Self-heal a half-completed enrollment: the row exists but the key
        // was never reported (mid-enroll crash/refresh) — QR-less and
        // invisible to vouchers until the key lands (§4.2). Ready custody
        // re-derives the same key, so re-report it and reload.
        if (
          device === "ready" &&
          !loaded.me.publicKey &&
          (await repairEnrollment(loaded).catch(() => false))
        ) {
          loaded = await loadEnv();
          setEnv(loaded);
          if (loaded.me.publicKey) setFingerprint(await keyFingerprint(loaded.me.publicKey));
        }
      } else {
        setDeviceStatus(null);
      }
      // Enrolled devices freshen the verified mirror opportunistically (§5.5).
      if (loaded.bootstrapped && loaded.enabled && loaded.me.identityStatus && loaded.rosterLedgerKey) {
        const { rawDocs } = await loadRoster(loaded);
        await reportRoster(loaded, rawDocs).catch(() => {});
        setEnv(await loadEnv());
      }
    } catch (err) {
      setError(thrown(err, t("loadFailed")));
    }
  }, [t, thrown]);

  async function patchRegistry(patch: { enabled?: boolean; scope?: "allowlist" | "everyone" }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/esign/registry", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? t("switchFailed"));
      await refresh();
    } catch (err) {
      setError(thrown(err, t("switchFailed")));
    } finally {
      setBusy(false);
    }
  }
  const toggleEnabled = (next: boolean) => patchRegistry({ enabled: next });
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const vouchUrl = useMemo(() => {
    if (!env?.me.publicKey) return null;
    const payload = {
      uid: env.me.userId,
      email: env.me.email,
      name: env.me.name,
      publicKey: env.me.publicKey,
    };
    const encoded = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `${window.location.origin}/vouch?c=${encoded}`;
  }, [env]);

  async function doBootstrap() {
    setBusy(true);
    setError(null);
    try {
      await bootstrapRegistry((await loadEnv())!);
      await refresh();
    } catch (err) {
      setError(thrown(err, t("setupFailed")));
    } finally {
      setBusy(false);
    }
  }

  if (!env) return null;

  // Master switch off (A5) or outside the rollout allowlist (A8): the system
  // is invisible to regular members — only the admin sees the card, reduced
  // to the switch and rollout controls.
  if (env.bootstrapped && (!env.enabled || env.allowed === false) && !env.canToggle) return null;

  const status = env.me.identityStatus;
  const statusChip =
    status === "attested" ? (
      <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">{t("chipReady")}</span>
    ) : status === "pending" ? (
      <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">{t("chipPending")}</span>
    ) : status === "revoked" ? (
      <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-800">{t("chipRevoked")}</span>
    ) : (
      <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-600">{t("chipNone")}</span>
    );

  const roleName = (["member", "approver", "treasurer", "admin"] as const).find(
    (r) => r === env.me.role
  );

  return (
    <div className="card space-y-4 p-5" data-testid="signing-identity-card">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">{t("title")}</h2>
        {/* While the system is off, an attestation chip would contradict the
            switch row right below it. */}
        {env.enabled ? statusChip : null}
      </div>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {env.bootstrapped && env.canToggle && (
        <div
          className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${
            env.enabled ? "border-emerald-200 bg-emerald-50" : "border-stone-200 bg-stone-50"
          }`}
        >
          <div className="text-sm">
            <p className="font-semibold">{env.enabled ? t("switchOn") : t("switchOff")}</p>
            <p className="text-xs text-stone-500">
              {env.enabled ? t("switchOnBody") : t("switchOffBody")}
            </p>
          </div>
          <button
            className={env.enabled ? "btn-secondary" : "btn-primary"}
            disabled={busy}
            onClick={() => toggleEnabled(!env.enabled)}
            data-testid="esign-switch"
          >
            {busy ? "…" : env.enabled ? t("turnOff") : t("turnOn")}
          </button>
        </div>
      )}

      {/* Rollout scope (A8): staged rollout to an allowlist, or everyone. */}
      {env.bootstrapped && env.canToggle && env.enabled && (
        <div className="space-y-3 rounded-xl border border-stone-200 bg-white p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">{t("scopeTitle")}</p>
            <div className="flex gap-1">
              <button
                className={`rounded-lg border px-2 py-1 text-xs ${
                  env.scope !== "everyone"
                    ? "border-indigo-300 bg-indigo-50 font-semibold text-indigo-700"
                    : "border-stone-200 text-stone-500 hover:bg-stone-50"
                }`}
                disabled={busy}
                onClick={() => void patchRegistry({ scope: "allowlist" })}
                data-testid="scope-allowlist"
              >
                {t("scopeAllowlist")}
              </button>
              <button
                className={`rounded-lg border px-2 py-1 text-xs ${
                  env.scope === "everyone"
                    ? "border-indigo-300 bg-indigo-50 font-semibold text-indigo-700"
                    : "border-stone-200 text-stone-500 hover:bg-stone-50"
                }`}
                disabled={busy}
                onClick={() => void patchRegistry({ scope: "everyone" })}
                data-testid="scope-everyone"
              >
                {t("scopeEveryone")}
              </button>
            </div>
          </div>
          {env.scope !== "everyone" && <AllowlistPanel />}
        </div>
      )}

      {env.bootstrapped && !env.enabled ? null : !env.bootstrapped ? (
        env.canBootstrap ? (
          <div className="space-y-3">
            <p className="text-sm text-stone-600">
              {t.rich("bootstrapIntro", { b: (chunks) => <strong>{chunks}</strong> })}
            </p>
            <button className="btn-primary" onClick={doBootstrap} disabled={busy} data-testid="esign-bootstrap">
              {busy ? t("bootstrapBusy") : t("bootstrapButton")}
            </button>
          </div>
        ) : (
          <p className="text-sm text-stone-500">{t("notSetUp")}</p>
        )
      ) : !status ? (
        <div className="space-y-3">
          <p className="text-sm text-stone-600">{t("enrollIntro")}</p>
          <button className="btn-primary" onClick={() => setWizardOpen(true)} data-testid="enable-signing">
            {t("enrollButton")}
          </button>
        </div>
      ) : deviceStatus === null ? (
        <p className="text-sm text-stone-400">{t("checkingDevice")}</p>
      ) : deviceStatus !== "ready" ? (
        // Enrolled member, but the keys aren't on this browser (M2).
        <NewDeviceCard
          env={env}
          fleetGone={deviceStatus === "fresh"}
          onReady={refresh}
          onStartOver={() => {
            setDeviceStatus("fresh");
            setWizardOpen(true);
          }}
        />
      ) : (
        <div className="space-y-4">
          {env.me.signatureImage ? (
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-stone-500">{t("yourSignature")}</p>
                <button
                  className="text-xs text-indigo-600 underline"
                  onClick={() => setRedrawOpen(true)}
                  data-testid="redraw-signature"
                >
                  {t("redraw")}
                </button>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={env.me.signatureImage} alt={tEsign("signatureAlt")} className="mt-1 h-14 object-contain" />
            </div>
          ) : (
            // e.g. the root, whose bootstrap path skips the wizard.
            <button
              className="btn-secondary"
              onClick={() => setRedrawOpen(true)}
              data-testid="add-signature"
            >
              {t("addSignature")}
            </button>
          )}

          {status === "pending" && vouchUrl && (
            <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-900">
                {t.rich("pendingVouch", { b: (chunks) => <b>{chunks}</b> })}
              </p>
              <IdentityQr url={vouchUrl} />
            </div>
          )}

          {status === "attested" && (
            <div className="flex flex-wrap gap-2">
              {/* Client-side nav keeps the in-memory Firebase session alive —
                  a full reload would re-prompt if persistence restore fails. */}
              <Link href="/vouch" className="btn-secondary inline-block" data-testid="vouch-link">
                {t("vouchForMember")}
              </Link>
            </div>
          )}

          <RecoveryCard env={env} sticky={env.me.role === "admin"} />
          <DevicesPanel env={env} />

          <details className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600">
            <summary className="cursor-pointer select-none font-medium text-stone-500">
              {tEsign("auditDetails")}
            </summary>
            <div className="mt-2 grid gap-1">
              <div>
                {t("roleLabel")}{" "}
                <span className="font-medium">{roleName ? tRole(roleName) : env.me.role}</span>
              </div>
              {fingerprint && (
                <div>
                  {t("yourFingerprint")}{" "}
                  <code className="font-mono" data-testid="identity-fingerprint">
                    {fingerprintDisplay(fingerprint)}
                  </code>
                  <span className="ml-1 text-stone-400">{t("fullFingerprint", { fp: fingerprint })}</span>
                </div>
              )}
              {env.rootFingerprint && (
                <div>
                  {t("rootFingerprint")}{" "}
                  <code className="font-mono">{fingerprintDisplay(env.rootFingerprint)}</code>
                  <span className="ml-1 text-stone-400">{t("compareNote")}</span>
                </div>
              )}
            </div>
          </details>
        </div>
      )}

      {wizardOpen && (
        <EnrollWizard
          env={env}
          onClose={() => setWizardOpen(false)}
          onDone={async () => {
            setWizardOpen(false);
            await refresh();
          }}
        />
      )}
      {redrawOpen && (
        <RedrawDialog
          onClose={() => setRedrawOpen(false)}
          onDone={async () => {
            setRedrawOpen(false);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function EnrollWizard({
  env,
  onClose,
  onDone,
}: {
  env: EsignEnv;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const t = useTranslations("Identity");
  const tEsign = useTranslations("Esign");
  const tCommon = useTranslations("Common");
  const thrown = useThrownErrorMessage();
  const [step, setStep] = useState<"consent" | "draw">("consent");
  const [consented, setConsented] = useState(false);
  const [signatureImage, setSignatureImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await enroll(env, signatureImage!);
      await onDone();
    } catch (err) {
      setError(thrown(err, t("setupFailed")));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" role="dialog">
      <div className="max-h-[92vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-2xl bg-white p-6 sm:rounded-2xl">
        {step === "consent" ? (
          <>
            <h3 className="text-lg font-bold">{t("consentTitle")}</h3>
            <p className="text-sm text-stone-600">{t("consentIntro")}</p>
            {/* Hash-bound English ueta-v1 text — see EsignPanel's note. */}
            <p className="text-xs text-stone-400">{tEsign("consentEnglishNote")}</p>
            <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-xs text-stone-700">
              {CONSENT_TEXT}
            </pre>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={consented}
                onChange={(e) => setConsented(e.target.checked)}
                data-testid="consent-checkbox"
              />
              <span>{t("agreeCheckbox")}</span>
            </label>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={onClose}>
                {tCommon("cancel")}
              </button>
              <button
                className="btn-primary disabled:opacity-50"
                disabled={!consented}
                onClick={() => setStep("draw")}
                data-testid="consent-next"
              >
                {t("consentNext")}
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="text-lg font-bold">{t("drawTitle")}</h3>
            <p className="text-sm text-stone-600">{t("drawIntro")}</p>
            <SignaturePad onChange={setSignatureImage} />
            {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setStep("consent")}>
                {tCommon("back")}
              </button>
              <button
                className="btn-primary disabled:opacity-50"
                disabled={!signatureImage || busy}
                onClick={finish}
                data-testid="finish-enroll"
              >
                {busy ? t("finishing") : t("finishSetup")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RedrawDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const t = useTranslations("Identity");
  const tCommon = useTranslations("Common");
  const thrown = useThrownErrorMessage();
  const [signatureImage, setSignatureImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" role="dialog">
      <div className="w-full max-w-lg space-y-4 rounded-t-2xl bg-white p-6 sm:rounded-2xl">
        <h3 className="text-lg font-bold">{t("redrawTitle")}</h3>
        <p className="text-sm text-stone-600">{t("redrawBody")}</p>
        <SignaturePad onChange={setSignatureImage} />
        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>
            {tCommon("cancel")}
          </button>
          <button
            className="btn-primary disabled:opacity-50"
            disabled={!signatureImage || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await updateSignatureImage(signatureImage!);
                await onDone();
              } catch (err) {
                setError(thrown(err, t("couldNotSave")));
                setBusy(false);
              }
            }}
            data-testid="save-signature"
          >
            {busy ? tCommon("saving") : t("saveSignature")}
          </button>
        </div>
      </div>
    </div>
  );
}
