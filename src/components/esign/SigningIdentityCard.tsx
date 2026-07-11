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
import {
  bootstrapRegistry,
  enroll,
  loadEnv,
  loadRoster,
  reportRoster,
  updateSignatureImage,
  type EsignEnv,
} from "@/lib/esign/client";
import { fingerprintDisplay, keyFingerprint } from "@/lib/esign/canonical";
import { CONSENT_TEXT } from "@/lib/esign/consent";
import IdentityQr from "./IdentityQr";
import SignaturePad from "./SignaturePad";

export default function SigningIdentityCard() {
  const [env, setEnv] = useState<EsignEnv | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [redrawOpen, setRedrawOpen] = useState(false);
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
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setBusy(false);
    }
  }

  if (!env) return null;

  const status = env.me.identityStatus;
  const statusChip =
    status === "attested" ? (
      <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">Ready to sign</span>
    ) : status === "pending" ? (
      <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">Almost there</span>
    ) : status === "revoked" ? (
      <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-800">Turned off</span>
    ) : (
      <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-600">Not set up</span>
    );

  return (
    <div className="card space-y-4 p-5" data-testid="signing-identity-card">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Electronic signing</h2>
        {statusChip}
      </div>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {!env.bootstrapped ? (
        env.canBootstrap ? (
          <div className="space-y-3">
            <p className="text-sm text-stone-600">
              You&apos;re set up as the person who starts electronic signing for this church.
              This takes one tap; afterwards, share the &ldquo;church code&rdquo; it shows with
              your members so they can check it.
            </p>
            <button className="btn-primary" onClick={doBootstrap} disabled={busy} data-testid="esign-bootstrap">
              {busy ? "Setting up…" : "Turn on electronic signing"}
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
            Sign and approve reimbursements from your phone — no printing. You&apos;ll agree to
            sign electronically, draw your signature, and then two members confirm it&apos;s
            really you (in person, one quick scan).
          </p>
          <button className="btn-primary" onClick={() => setWizardOpen(true)} data-testid="enable-signing">
            Set up signing
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {env.me.signatureImage ? (
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-stone-500">Your signature</p>
                <button
                  className="text-xs text-indigo-600 underline"
                  onClick={() => setRedrawOpen(true)}
                  data-testid="redraw-signature"
                >
                  Redraw
                </button>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={env.me.signatureImage} alt="Your signature" className="mt-1 h-14 object-contain" />
            </div>
          ) : (
            // e.g. the root, whose bootstrap path skips the wizard.
            <button
              className="btn-secondary"
              onClick={() => setRedrawOpen(true)}
              data-testid="add-signature"
            >
              ✍️ Add your signature
            </button>
          )}

          {status === "pending" && vouchUrl && (
            <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-900">
                One last step: show this to two members (or one approver) <b>in person</b>.
                They scan it with their phone camera and confirm it&apos;s really you.
              </p>
              <IdentityQr url={vouchUrl} />
            </div>
          )}

          {status === "attested" && (
            <div className="flex flex-wrap gap-2">
              <a href="/vouch" className="btn-secondary inline-block" data-testid="vouch-link">
                🤝 Vouch for a member
              </a>
            </div>
          )}

          <details className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600">
            <summary className="cursor-pointer select-none font-medium text-stone-500">
              Audit details
            </summary>
            <div className="mt-2 grid gap-1">
              <div>
                Role: <span className="font-medium capitalize">{env.me.role}</span>
              </div>
              {fingerprint && (
                <div>
                  Your key fingerprint:{" "}
                  <code className="font-mono" data-testid="identity-fingerprint">
                    {fingerprintDisplay(fingerprint)}
                  </code>
                  <span className="ml-1 text-stone-400">(full: {fingerprint})</span>
                </div>
              )}
              {env.rootFingerprint && (
                <div>
                  Church root fingerprint:{" "}
                  <code className="font-mono">{fingerprintDisplay(env.rootFingerprint)}</code>
                  <span className="ml-1 text-stone-400">— compare against the published value</span>
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
      setError(err instanceof Error ? err.message : "Setup failed");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" role="dialog">
      <div className="max-h-[92vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-2xl bg-white p-6 sm:rounded-2xl">
        {step === "consent" ? (
          <>
            <h3 className="text-lg font-bold">Sign electronically instead of on paper</h3>
            <p className="text-sm text-stone-600">
              Please read this once — it says your electronic signature counts like an ink one,
              and that you can always go back to paper.
            </p>
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
              <span>I agree to sign electronically.</span>
            </label>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn-primary disabled:opacity-50"
                disabled={!consented}
                onClick={() => setStep("draw")}
                data-testid="consent-next"
              >
                Next: draw your signature
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="text-lg font-bold">Draw your signature</h3>
            <p className="text-sm text-stone-600">
              This is the signature that appears on the reimbursement forms — sign the way you
              would on paper, with your finger or the mouse.
            </p>
            <SignaturePad onChange={setSignatureImage} />
            {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setStep("consent")}>
                Back
              </button>
              <button
                className="btn-primary disabled:opacity-50"
                disabled={!signatureImage || busy}
                onClick={finish}
                data-testid="finish-enroll"
              >
                {busy ? "Finishing…" : "Finish setup"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RedrawDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [signatureImage, setSignatureImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" role="dialog">
      <div className="w-full max-w-lg space-y-4 rounded-t-2xl bg-white p-6 sm:rounded-2xl">
        <h3 className="text-lg font-bold">Redraw your signature</h3>
        <p className="text-sm text-stone-600">
          The new drawing is used on paperwork you sign from now on; nothing already signed
          changes.
        </p>
        <SignaturePad onChange={setSignatureImage} />
        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
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
                setError(err instanceof Error ? err.message : "Could not save");
                setBusy(false);
              }
            }}
            data-testid="save-signature"
          >
            {busy ? "Saving…" : "Save signature"}
          </button>
        </div>
      </div>
    </div>
  );
}
