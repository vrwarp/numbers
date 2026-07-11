"use client";

/**
 * Profile-page card for the member's signing identity
 * (docs/ESIGN_DESIGN.md §4.2–4.3): bootstrap (root only), the
 * enable-signing wizard (consent → keys → roster join), the identity QR +
 * fingerprint for in-person vouching, and role display. The QR encodes a
 * /vouch URL so a voucher can scan it with their phone's native camera —
 * no in-app decoder needed.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  bootstrapRegistry,
  enroll,
  loadEnv,
  loadRoster,
  reportRoster,
  type EsignEnv,
} from "@/lib/esign/client";
import { fingerprintDisplay, keyFingerprint } from "@/lib/esign/canonical";
import { CONSENT_TEXT } from "@/lib/esign/consent";
import IdentityQr from "./IdentityQr";

export default function SigningIdentityCard() {
  const [env, setEnv] = useState<EsignEnv | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [consented, setConsented] = useState(false);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const loaded = await loadEnv();
      setEnv(loaded);
      if (loaded.me.publicKey) setFingerprint(await keyFingerprint(loaded.me.publicKey));
      // Enrolled devices freshen the verified mirror opportunistically (§5.5).
      if (loaded.bootstrapped && loaded.me.identityStatus && loaded.rosterLedgerKey) {
        const { rawDocs } = await loadRoster(loaded);
        await reportRoster(loaded, rawDocs).catch(() => {});
        setEnv(await loadEnv());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load signing status");
    }
  }, []);
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
      setError(err instanceof Error ? err.message : "Bootstrap failed");
    } finally {
      setBusy(false);
    }
  }

  async function doEnroll() {
    setBusy(true);
    setError(null);
    try {
      await enroll(env!);
      setWizardOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Enrollment failed");
    } finally {
      setBusy(false);
    }
  }

  if (!env) return null;

  const status = env.me.identityStatus;
  const statusChip =
    status === "attested" ? (
      <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">Attested</span>
    ) : status === "pending" ? (
      <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">Awaiting vouches</span>
    ) : status === "revoked" ? (
      <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-800">Revoked</span>
    ) : (
      <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-600">Not enrolled</span>
    );

  return (
    <div className="card space-y-4 p-5" data-testid="signing-identity-card">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Signing identity</h2>
        {statusChip}
      </div>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {!env.bootstrapped ? (
        env.canBootstrap ? (
          <div className="space-y-3">
            <p className="text-sm text-stone-600">
              You are the configured trust root. Initializing creates the church signing
              registry with your key as its anchor — publish the fingerprint it shows so
              members can verify it in person.
            </p>
            <button className="btn-primary" onClick={doBootstrap} disabled={busy} data-testid="esign-bootstrap">
              {busy ? "Initializing…" : "Initialize signing registry"}
            </button>
          </div>
        ) : (
          <p className="text-sm text-stone-500">
            Electronic signing isn&apos;t set up for this church yet — ask your administrator.
          </p>
        )
      ) : !status ? (
        <div className="space-y-3">
          <p className="text-sm text-stone-600">
            Enable signing to submit claims for approval electronically. Your signing key is
            created on this device and never leaves it; two members (or one approver) must
            vouch for you in person before it counts.
          </p>
          <button className="btn-primary" onClick={() => setWizardOpen(true)} data-testid="enable-signing">
            Enable signing
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-1 text-sm">
            <div>
              <span className="text-stone-500">Role: </span>
              <span className="font-medium capitalize">{env.me.role}</span>
            </div>
            {fingerprint && (
              <div>
                <span className="text-stone-500">Key fingerprint: </span>
                <code className="font-mono text-xs" data-testid="identity-fingerprint">
                  {fingerprintDisplay(fingerprint)}
                </code>
              </div>
            )}
            {env.rootFingerprint && (
              <div>
                <span className="text-stone-500">Church root fingerprint: </span>
                <code className="font-mono text-xs">{fingerprintDisplay(env.rootFingerprint)}</code>
                <span className="ml-2 text-xs text-stone-400">(compare against the published value)</span>
              </div>
            )}
          </div>

          {status === "pending" && vouchUrl && (
            <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-900">
                Show this to two members (or one approver) IN PERSON — they scan it with
                their phone camera and confirm it&apos;s really you:
              </p>
              <IdentityQr url={vouchUrl} />
              {fingerprint && (
                <p className="text-xs text-amber-800">
                  If scanning fails they can type your full fingerprint instead:{" "}
                  <code className="font-mono">{fingerprint}</code>
                </p>
              )}
            </div>
          )}

          {status === "attested" && (
            <a href="/vouch" className="btn-secondary inline-block" data-testid="vouch-link">
              🤝 Vouch for a member
            </a>
          )}
        </div>
      )}

      {wizardOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" role="dialog">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-6 sm:rounded-2xl">
            <h3 className="text-lg font-bold">Enable electronic signing</h3>
            <pre className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-xs text-stone-700">
              {CONSENT_TEXT}
            </pre>
            <label className="mt-3 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={consented}
                onChange={(e) => setConsented(e.target.checked)}
                data-testid="consent-checkbox"
              />
              <span>I agree to conduct these transactions electronically.</span>
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setWizardOpen(false)}>
                Cancel
              </button>
              <button
                className="btn-primary disabled:opacity-50"
                disabled={!consented || busy}
                onClick={doEnroll}
                data-testid="finish-enroll"
              >
                {busy ? "Creating keys…" : "Create my signing key"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
