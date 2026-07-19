"use client";

/**
 * Voucher's side of the in-person ceremony (docs/ESIGN_DESIGN.md §4.3).
 * The QR scan is the binding channel — either a `/vouch?c=` URL the voucher
 * opened (their phone's camera app followed the link) or, better on
 * multi-browser devices, an in-page scan (VouchQrScanner) that reads the
 * candidate's QR right here in the browser already holding the voucher's key
 * and session. The pending-list fallback carries no binding, so it requires
 * the candidate's FULL 64-hex key fingerprint — never the 6-digit spoken
 * code, which is grindable. The voucher's one job is confirming the human in
 * front of them matches the identity on screen.
 *
 * Roster administration (roles, key revocation, the attested-members list)
 * lives on the Members page (/members) — this screen is the ceremony only.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useTranslations } from "next-intl";
import {
  custodyFor,
  backendNeedsPopup,
  loadEnv,
  loadRoster,
  vouchFor,
  type EsignEnv,
  type VouchSubject,
} from "@/lib/esign/client";
import { fingerprintDisplay, keyFingerprint } from "@/lib/esign/canonical";
import { ROLE_MANAGER_ROLES } from "@/lib/esign/types";
import { decodeSubject } from "@/lib/esign/vouch-scan";
import { useThrownErrorMessage } from "@/lib/use-api-error";
import VouchQrScanner from "./VouchQrScanner";
import { SigningConnectCard, useSigningSession } from "./SigningConnect";

function VouchInner() {
  const t = useTranslations("Vouch");
  const tEsign = useTranslations("Esign");
  const tCommon = useTranslations("Common");
  const thrown = useThrownErrorMessage();
  const params = useSearchParams();
  const [env, setEnv] = useState<EsignEnv | null>(null);
  const [subject, setSubject] = useState<VouchSubject | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [manualFp, setManualFp] = useState("");
  const [pending, setPending] = useState<VouchSubject[]>([]);
  // Active roster keys per uid — the source of truth for spotting a RE-KEY
  // vouch (the mirror's members list can't see it: a re-enrolling member's
  // row is already pending on their NEW key while the roster still attests
  // the old one).
  const [activeKeys, setActiveKeys] = useState<Record<string, string[]>>({});
  const [confirmed, setConfirmed] = useState(false);
  // True once the subject arrived over a binding channel — the QR in the URL
  // (`c`) or an in-page camera scan — as opposed to being hand-picked from the
  // pending list, which still demands the full fingerprint (§4.3).
  const [scannedBinding, setScannedBinding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const encoded = params.get("c");

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await loadEnv();
        setEnv(loaded);
        if (encoded) {
          const s = decodeSubject(encoded);
          if (!s) setError(t("malformedLink"));
          else {
            setSubject(s);
            setFingerprint(await keyFingerprint(s.publicKey));
          }
        } else {
          // Manual path: list enrollment candidates awaiting vouches.
          const res = await fetch("/api/esign/pending");
          if (res.ok) setPending(((await res.json()).pending ?? []) as VouchSubject[]);
        }
      } catch (err) {
        setError(thrown(err, tEsign("loadFailed")));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encoded]);

  const { phase, connect, connecting, error: connectError } = useSigningSession(env);

  // Active roster keys read the ledger backend (a Google popup on prod), so
  // only load them once this device has a signing session (below the connect
  // gate) — never on mount, where a fresh Safari load would pop.
  useEffect(() => {
    if (phase !== "ready" || !env) return;
    if (!(env.enabled && env.me.identityStatus && env.rosterLedgerKey)) return;
    void (async () => {
      try {
        const { roster } = await loadRoster(env);
        const byUid: Record<string, string[]> = {};
        for (const m of roster.members) {
          if (m.revokedAtMs === undefined) (byUid[m.uid] ??= []).push(m.publicKey);
        }
        setActiveKeys(byUid);
      } catch {
        // A missing roster read just hides the re-key notice; not fatal here.
      }
    })();
  }, [phase, env]);

  // Whether THIS browser holds the voucher's signing key. Without it the
  // ceremony fails closed only AFTER the confirm + sign attempt — surface the
  // new-device state up front instead of at the last step.
  const [deviceReady, setDeviceReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (phase !== "ready" || !env || env.me.identityStatus !== "attested") return;
    void custodyFor(env)
      .deviceStatus()
      .then((d) => setDeviceReady(d === "ready"))
      .catch(() => setDeviceReady(null));
  }, [phase, env]);

  const canVouch =
    env?.enabled === true && env.allowed !== false && env.me.identityStatus === "attested";
  const mustConnect = !!env && backendNeedsPopup(env) && phase !== "ready";
  // URL `c` and camera scan are both binding channels; a pending-list pick is not.
  const strongBinding = Boolean(encoded) || scannedBinding;
  const manualMatches = useMemo(() => {
    const typed = manualFp.toLowerCase().replace(/[^0-9a-f]/g, "");
    return typed.length >= 32 && fingerprint?.startsWith(typed);
  }, [manualFp, fingerprint]);

  async function handleScanned(s: VouchSubject) {
    setSubject(s);
    setScannedBinding(true);
    setFingerprint(await keyFingerprint(s.publicKey));
  }

  async function submitVouch() {
    if (!env || !subject) return;
    setBusy(true);
    setError(null);
    try {
      await vouchFor(env, subject);
      setDone(true);
    } catch (err) {
      setError(thrown(err, t("vouchFailed")));
    } finally {
      setBusy(false);
    }
  }

  if (!env) return <p className="text-sm text-stone-500">{tCommon("loading")}</p>;

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {/* Fail early, not at the final step: without the signing key on THIS
          browser the ceremony would only reject after confirm + sign. */}
      {canVouch && !mustConnect && deviceReady === false && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="keyless-device-note">
          {t("keylessDevice")}
        </p>
      )}

      {!canVouch ? (
        <p className="card p-5 text-sm text-stone-600">
          {t.rich("onlyAttested", {
            link: (chunks) => (
              <Link href="/profile" className="text-indigo-600 underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      ) : mustConnect ? (
        // Connect the signing session before any vouch / role action, so the
        // Google popup opens from this click (iOS/Safari popup rule).
        <div className="card p-5">
          <SigningConnectCard connect={connect} connecting={connecting} error={connectError} />
        </div>
      ) : done ? (
        <div className="card space-y-2 p-5" data-testid="vouch-done">
          <div className="text-3xl">✅</div>
          <p className="font-medium">{t("doneTitle", { name: subject?.name ?? "" })}</p>
          <p className="text-sm text-stone-500">{t("doneBody")}</p>
        </div>
      ) : subject ? (
        <div className="card space-y-4 p-5">
          <div>
            <div className="text-lg font-semibold" data-testid="vouch-subject-name">{subject.name}</div>
            <div className="text-sm text-stone-500">{subject.email}</div>
            {fingerprint && (
              <details className="mt-1 text-xs text-stone-500">
                <summary className="cursor-pointer select-none">{tEsign("auditDetails")}</summary>
                <code className="mt-1 block font-mono">{fingerprintDisplay(fingerprint)}</code>
              </details>
            )}
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-semibold">{t("beforeTitle")}</p>
            <ul className="mt-1 list-inside list-disc space-y-1">
              <li>{t("bullet1")}</li>
              <li>{t("bullet2")}</li>
              <li>{t("bullet3")}</li>
            </ul>
          </div>
          {(activeKeys[subject.uid] ?? []).some((k) => k !== subject.publicKey) && (
            <div
              className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900"
              data-testid="rekey-notice"
            >
              <p className="font-semibold">{t("rekeyTitle", { name: subject.name })}</p>
              <p className="mt-1">{t("rekeyBody")}</p>
            </div>
          )}
          {!strongBinding && (
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("manualLabel")}</label>
              <input
                className="input font-mono text-xs"
                placeholder={t("manualPlaceholder")}
                value={manualFp}
                onChange={(e) => setManualFp(e.target.value)}
                data-testid="manual-fingerprint"
              />
              {!manualMatches && manualFp.length > 0 && (
                <p className="text-xs text-red-600">{t("fpMismatch")}</p>
              )}
            </div>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              data-testid="vouch-confirm"
            />
            <span>
              {t.rich("confirmLabel", {
                name: subject.name,
                b: (chunks) => <strong>{chunks}</strong>,
              })}
            </span>
          </label>
          <button
            className="btn-primary w-full disabled:opacity-50"
            disabled={!confirmed || busy || (!strongBinding && !manualMatches)}
            onClick={submitVouch}
            data-testid="vouch-submit"
          >
            {busy ? tEsign("signing") : t("signVouch")}
          </button>
        </div>
      ) : (
        <div className="card space-y-4 p-5">
          <p className="text-sm text-stone-600">
            {t.rich("scanIntro", { b: (chunks) => <strong>{chunks}</strong> })}
          </p>
          <VouchQrScanner onScan={handleScanned} />
          <div className="space-y-2 border-t border-stone-100 pt-3">
            <p className="text-sm font-medium text-stone-500">{t("orPick")}</p>
            {pending.length === 0 ? (
              <p className="text-sm text-stone-500">{t("nobodyPending")}</p>
            ) : (
              <ul className="space-y-2">
                {pending.map((p) => (
                  <li key={p.uid}>
                    <button
                      className="btn-secondary w-full text-left"
                      onClick={async () => {
                        setSubject(p);
                        setFingerprint(await keyFingerprint(p.publicKey));
                      }}
                    >
                      {p.name} <span className="text-stone-400">({p.email})</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* The attested-members roster (roles, keys, e-sign access) moved to the
          Members page — point the people who can manage it there. */}
      {(ROLE_MANAGER_ROLES as readonly string[]).includes(env.me.role) && (
        <p className="text-sm text-stone-500">
          {t.rich("membersPageHint", {
            link: (chunks) => (
              <Link href="/members" className="text-indigo-600 underline" data-testid="vouch-members-link">
                {chunks}
              </Link>
            ),
          })}
        </p>
      )}
    </div>
  );
}

export default function VouchScreen() {
  return (
    <Suspense fallback={<Fallback />}>
      <VouchInner />
    </Suspense>
  );
}

function Fallback() {
  const tCommon = useTranslations("Common");
  return <p className="text-sm text-stone-500">{tCommon("loading")}</p>;
}
