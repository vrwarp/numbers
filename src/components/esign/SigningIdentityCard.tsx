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
import { useTranslations } from "next-intl";
import { useOpenParam } from "@/lib/use-open-param";
import {
  backendNeedsPopup,
  bootstrapRegistry,
  custodyFor,
  enroll,
  hasSigningSession,
  loadEnv,
  loadRoster,
  repairEnrollment,
  reportRoster,
  subscribeRoster,
  updateSignatureImage,
  type EsignEnv,
} from "@/lib/esign/client";
import type { DeviceStatus } from "@/lib/esign/custody";
import { fingerprintDisplay, keyFingerprint } from "@/lib/esign/canonical";
import { CONSENT_TEXT } from "@/lib/esign/consent";
import { useThrownErrorMessage } from "@/lib/use-api-error";
import Link from "next/link";
import { roleLabelKey } from "@/lib/role-label";
import { DevicesPanel, NewDeviceCard, RecoveryCard } from "./DeviceManager";
import { SigningConnectCard, useSigningSession } from "./SigningConnect";
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
      // Device fleet + roster reads hit the ledger backend, which on production
      // Firestore means a Google popup. Don't touch them until this device has
      // a signing session — the connect card establishes one from a click, so a
      // fresh Safari load never pops on mount. Re-runs once connected (below).
      if (!(await hasSigningSession(loaded))) {
        setDeviceStatus(null);
        return;
      }
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

  const { phase, connect, connecting, error: connectError, justConnected } = useSigningSession(env);

  // Load the environment up front — no ledger reads, so no popup — so the gate
  // can decide and the header renders. The heavy device/roster reads that would
  // pop wait for a signing session (the effect below).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadEnv();
        if (cancelled) return;
        setEnv(loaded);
        if (loaded.me.publicKey) setFingerprint(await keyFingerprint(loaded.me.publicKey));
      } catch (err) {
        if (!cancelled) setError(thrown(err, t("loadFailed")));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t, thrown]);

  // Once the signing session is ready, run the full refresh (device fleet +
  // roster mirror) — the reads the popup was gating.
  useEffect(() => {
    if (phase === "ready") void refresh();
  }, [phase, refresh]);

  // Fold the "Enable signing" tap into the connect click: a never-enrolled
  // member who just connected the signing session (Google popup) lands straight
  // on the enroll consent instead of a second button. Gated on justConnected so
  // this fires only after the interactive click, never on a restored session at
  // page load; and on a null identityStatus so the new-device / already-enrolled
  // branches are untouched. The wizard is a plain DOM modal (no popup), so it
  // needs no user gesture to open.
  useEffect(() => {
    if (justConnected && env?.bootstrapped && env.enabled && !env.me.identityStatus) {
      setWizardOpen(true);
    }
  }, [justConnected, env?.bootstrapped, env?.enabled, env?.me.identityStatus]);

  // Live-update: while enrolled with a roster session, watch the roster ledger
  // so a vouch (pending → attested), role grant, or key revocation made
  // elsewhere updates this card without a manual reload (Firestore onSnapshot on
  // prod, polling on the mock backend). Keyed on the stable roster identifiers,
  // not the whole env object, so a refresh()-driven setEnv doesn't tear down and
  // re-attach the listener.
  useEffect(() => {
    if (phase !== "ready" || !env) return;
    if (!(env.enabled && env.me.identityStatus && env.rosterLedgerId && env.rosterLedgerKey)) return;
    return subscribeRoster(env, () => void refresh());
    // env is read only for its roster identifiers (all in the deps below); the
    // fresh env is re-read inside refresh(), so a stale closure is harmless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, env?.rosterLedgerId, env?.rosterLedgerKey, env?.me.identityStatus, env?.enabled, env?.backend, refresh]);

  // PRE-B (docs/ESIGN_SETUP_DISCOVERABILITY.md §3.4): every nudge CTA lands on
  // /profile?open=esign — adopt the app-wide open-param contract (scroll +
  // pulse). `ready` waits for the env load so the card exists to land on; an
  // ineligible visitor's card renders null and the miss just strips the param.
  useOpenParam({
    ready: env !== null,
    exists: (id) =>
      id === "esign" &&
      !!env &&
      !(env.bootstrapped && (!env.enabled || env.allowed === false) && !env.canToggle),
  });

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
  // Pending is PROGRESS, so its chip is indigo like every other member-facing
  // pending surface — amber would read as escalation for being further along.
  const statusChip =
    status === "attested" ? (
      <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">{t("chipReady")}</span>
    ) : status === "pending" ? (
      <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">{t("chipPending")}</span>
    ) : status === "revoked" ? (
      <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-800">{t("chipRevoked")}</span>
    ) : (
      <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-600">{t("chipNone")}</span>
    );

  const roleName = roleLabelKey(env.me.role);

  // Bootstrap, enrollment, and device/roster reads all need a signing session.
  // On production Firestore, gate them behind an explicit connect click so the
  // Google popup opens in-gesture (iOS/Safari blocks it otherwise).
  const mustConnect = backendNeedsPopup(env) && phase !== "ready";
  const connectGate =
    phase === "connect" ? (
      <div className="space-y-2">
        {/* Connect-gate framing (§3.4): the nudges promise "about two minutes";
            on production the FIRST tap is a Google popup — say so in plain
            words before the credential card, for the null and pending paths
            alike, so the promise survives the landing. */}
        <p className="text-sm text-stone-600" data-testid="connect-framing">
          {t("connectFraming")}
        </p>
        <SigningConnectCard connect={connect} connecting={connecting} error={connectError} />
      </div>
    ) : (
      <p className="text-sm text-stone-400">{t("checkingDevice")}</p>
    );

  return (
    <div className="card space-y-4 p-5" data-testid="signing-identity-card" data-open-id="esign">
      {/* flex-wrap: at 390px a long chip drops cleanly below the title instead
          of squeezing both into a four-line pile. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
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
          {/* Per-person grants were defragmented onto the Members page — the
              scope switch stays here with the rest of the master controls. */}
          {env.scope !== "everyone" && (
            <p className="rounded-lg bg-stone-50 p-2.5 text-xs text-stone-600">
              {t.rich("allowlistOnMembersPage", {
                link: (chunks) => (
                  <Link href="/members" className="text-indigo-600 underline" data-testid="profile-members-link">
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          )}
        </div>
      )}

      {env.bootstrapped && !env.enabled ? null : !env.bootstrapped ? (
        env.canBootstrap ? (
          mustConnect ? (
            connectGate
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-stone-600">
                {t.rich("bootstrapIntro", { b: (chunks) => <strong>{chunks}</strong> })}
              </p>
              <button className="btn-primary" onClick={doBootstrap} disabled={busy} data-testid="esign-bootstrap">
                {busy ? t("bootstrapBusy") : t("bootstrapButton")}
              </button>
            </div>
          )
        ) : (
          <p className="text-sm text-stone-500">{t("notSetUp")}</p>
        )
      ) : mustConnect ? (
        connectGate
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
              {/* The voucher's instinct is to raise their phone's CAMERA APP at
                  this QR — which opens a logged-out browser and strands them.
                  Steer them to the in-app scanner right where they'll look. */}
              <p className="text-xs text-amber-800" data-testid="scan-hint">
                {t("scanFromVouchTab")}
              </p>
              <VoucherDirectory meUserId={env.me.userId} />
              {fingerprint && <ManualCodeFallback fingerprint={fingerprint} />}
            </div>
          )}
          {status === "revoked" && (
            <div className="space-y-2 rounded-xl border border-red-200 bg-red-50 p-4" data-testid="revoked-note">
              <p className="text-sm font-medium text-red-900">{t("revokedBody")}</p>
              <button className="btn-primary" onClick={() => setWizardOpen(true)} data-testid="re-enroll">
                {t("reEnrollButton")}
              </button>
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

/**
 * Camera-less fallback for the pending candidate (§4.3). The QR scan is the
 * primary binding channel; when the voucher can't scan, they pick the
 * candidate from the pending list and type this **full key fingerprint** — the
 * only manual channel the ceremony accepts (a short spoken code is grindable,
 * so it's never sufficient). Grouped for readability and copyable; kept behind
 * a disclosure so the plain-language main path stays a QR and nothing more.
 */
function ManualCodeFallback({ fingerprint }: { fingerprint: string }) {
  const t = useTranslations("Identity");
  const [copied, setCopied] = useState(false);
  const grouped = fingerprint.match(/.{1,4}/g)?.join(" ") ?? fingerprint;
  async function copy() {
    try {
      await navigator.clipboard.writeText(fingerprint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (insecure context / denied) — the code is still
      // selectable by hand, so this is a no-op, not an error.
    }
  }
  return (
    <details className="rounded-lg border border-amber-200 bg-white/70 px-3 py-2 text-xs">
      <summary className="cursor-pointer select-none font-medium text-amber-900">
        {t("manualFallbackTitle")}
      </summary>
      <p className="mt-2 text-stone-600">{t("manualFallbackBody")}</p>
      <div className="mt-2 flex items-start gap-2">
        <code
          className="flex-1 break-all select-all rounded bg-stone-50 p-2 font-mono text-[11px] leading-5 text-stone-700"
          data-testid="manual-vouch-fingerprint"
        >
          {grouped}
        </code>
        <button
          type="button"
          className="shrink-0 rounded-lg border border-stone-200 px-2 py-1 text-xs text-stone-600 hover:bg-stone-50"
          onClick={copy}
          data-testid="copy-fingerprint"
        >
          {copied ? t("copiedCode") : t("copyCode")}
        </button>
      </div>
    </details>
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
      <div className="max-h-[92dvh] w-full max-w-lg space-y-4 overflow-y-auto overscroll-contain rounded-t-2xl bg-white p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:rounded-2xl sm:pb-6">
        {step === "consent" ? (
          <>
            <h3 className="text-lg font-bold">{t("consentTitle")}</h3>
            <p className="text-sm text-stone-600">{t("consentIntro")}</p>
            {/* Hash-bound English ueta-v1 text — see EsignPanel's note. The
                gloss is a labeled plain-language SUMMARY in the UI language so
                a non-English reader isn't agreeing to a wall they can't read. */}
            <p className="text-xs text-stone-600">{tEsign("consentGloss")}</p>
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

/** "Who can vouch me in": the attested members a pending candidate needs to
 *  find in person. Without this the wait state is a dead end — a new member
 *  has no way to know who among the congregation is already a signer. */
function VoucherDirectory({ meUserId }: { meUserId: string }) {
  const t = useTranslations("Identity");
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/esign/members")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.members) return;
        setNames(
          (d.members as { userId: string; name: string }[])
            .filter((m) => m.userId !== meUserId)
            .map((m) => m.name)
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meUserId]);
  if (!names || names.length === 0) return null;
  const shown = names.slice(0, 8);
  return (
    <p className="text-xs text-amber-800" data-testid="voucher-directory">
      {t("whoCanVouch", { names: shown.join(", "), more: names.length - shown.length })}
    </p>
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
