"use client";

/**
 * Owner-side e-sign panel on the claim review screen
 * (docs/ESIGN_DESIGN.md §6.1): submit-for-approval ceremony from
 * `generated`, live chain verification + reassignment while `submitted`,
 * the rejection comment + resubmit path, and certificate download once
 * approved/paid.
 */

import { useEffect, useState } from "react";
import {
  loadEnv,
  runSubmitCeremony,
  withdrawSubmission,
  type EsignEnv,
} from "@/lib/esign/client";
import { CONSENT_TEXT, INTENT_AFFIRMATION } from "@/lib/esign/consent";
import { formatCents } from "@/lib/money";
import type { SignaturePlacement } from "@/lib/esign/placement";
import { AuditDetails, ThreadSignatures, VerifiedBanner, useClaimChain, type ClaimRef } from "./chain";
import DocumentSignField from "./DocumentSignField";

export interface EsignClaim extends ClaimRef {
  status: string;
  approverUserId: string | null;
  totalCents: number;
  checkNumber?: string;
}

interface Member {
  userId: string;
  name: string;
  email: string;
  role: string;
}

export default function EsignPanel({
  claim,
  onChanged,
}: {
  claim: EsignClaim;
  onChanged: () => Promise<void> | void;
}) {
  const [env, setEnv] = useState<EsignEnv | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const signed = ["submitted", "rejected", "approved", "paid"].includes(claim.status);
  // On the owner's review screen the claim's ownerUid IS the signed-in user.
  const chainClaim =
    signed && env ? { ...claim, ownerUid: claim.ownerUid || env.me.userId } : null;
  const { state, error: chainError, refresh } = useClaimChain(chainClaim);

  useEffect(() => {
    void loadEnv().then(setEnv).catch(() => {});
  }, []);

  // Master switch (A5): off ⇒ no e-sign affordances anywhere. Already-signed
  // claims still show their status chip, and /v links keep verifying.
  if (!env?.bootstrapped || !env.enabled) return null;

  if (claim.status === "generated") {
    return (
      <div className="card flex flex-wrap items-center justify-between gap-3 border-indigo-200 bg-indigo-50/60 p-4" data-testid="esign-panel">
        <div className="text-sm text-indigo-900">
          <span className="font-semibold">Ready for approval.</span> Submit this packet for an
          electronic signature instead of printing it.
        </div>
        <button className="btn-primary" onClick={() => setDialogOpen(true)} data-testid="submit-for-approval">
          ✍️ Submit for approval
        </button>
        {dialogOpen && (
          <SubmitDialog
            claim={claim}
            env={env}
            onClose={() => setDialogOpen(false)}
            onDone={async () => {
              setDialogOpen(false);
              await onChanged();
            }}
          />
        )}
      </div>
    );
  }

  if (!signed) return null;

  const decision = state?.thread?.decision?.action as
    | { t: string; comment?: string }
    | undefined;

  return (
    <div className="card space-y-3 p-4" data-testid="esign-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          {claim.status === "submitted" && "Awaiting approval"}
          {claim.status === "rejected" && "Rejected by the approver"}
          {claim.status === "approved" && "Approved — awaiting payment"}
          {claim.status === "paid" && `Paid${claim.checkNumber ? ` — check #${claim.checkNumber}` : ""}`}
        </h2>
      </div>
      {state && <VerifiedBanner state={state} />}
      {chainError && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{chainError}</p>}
      {decision?.t === "REJECT" && decision.comment && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="rejection-comment">
          Approver&apos;s comment: “{decision.comment}”
        </p>
      )}
      {state && <ThreadSignatures state={state} />}
      {state && <AuditDetails state={state} />}

      <div className="flex flex-wrap gap-2">
        {(claim.status === "approved" || claim.status === "paid") && (
          <a
            className="btn-secondary"
            href={`/api/reimbursements/${claim.id}/certificate`}
            data-testid="certificate-link"
          >
            📜 Approval certificate
          </a>
        )}
        {claim.status === "submitted" && state?.thread?.submit && (
          <button
            className="btn-secondary"
            data-testid="change-approver"
            onClick={async () => {
              if (!confirm("Withdraw this submission so you can pick a different approver?")) return;
              await withdrawSubmission(
                {
                  id: claim.id,
                  signatureLedgerId: claim.signatureLedgerId!,
                  signatureLedgerKey: claim.signatureLedgerKey!,
                },
                state.thread!.submit!.actionHash
              );
              await onChanged();
            }}
          >
            ↪ Withdraw / change approver
          </button>
        )}
        {claim.status === "rejected" && (
          <button className="btn-primary" onClick={() => setDialogOpen(true)} data-testid="resubmit">
            ✍️ Resubmit
          </button>
        )}
        <button className="btn-secondary" onClick={() => refresh()}>
          ⟳ Re-verify
        </button>
      </div>
      {dialogOpen && (
        <SubmitDialog
          claim={claim}
          env={env}
          onClose={() => setDialogOpen(false)}
          onDone={async () => {
            setDialogOpen(false);
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

function SubmitDialog({
  claim,
  env,
  onClose,
  onDone,
}: {
  claim: EsignClaim;
  env: EsignEnv;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [approverUserId, setApproverUserId] = useState("");
  const [typedName, setTypedName] = useState(env.me.name);
  const [affirmed, setAffirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [anchor, setAnchor] = useState<SignaturePlacement | null>(null);
  const [placement, setPlacement] = useState<SignaturePlacement | null>(null);
  const enrolled = env.me.identityStatus === "attested";
  const hasSignature = !!env.me.signatureImage;

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/esign/members");
      if (res.ok) {
        const all = ((await res.json()).members ?? []) as Member[];
        setMembers(
          all.filter(
            (m) => m.userId !== env.me.userId && ["approver", "treasurer", "admin"].includes(m.role)
          )
        );
      }
      if (enrolled && hasSignature) {
        const [pkt, anc] = await Promise.all([
          fetch(`/api/reimbursements/${claim.id}/packet`),
          fetch(`/api/reimbursements/${claim.id}/sign-anchor`),
        ]);
        if (pkt.ok) setBytes(await pkt.arrayBuffer());
        if (anc.ok) setAnchor((await anc.json()).anchor as SignaturePlacement);
      }
    })();
  }, [env.me.userId, claim.id, enrolled, hasSignature]);

  async function sign() {
    setBusy(true);
    setError(null);
    try {
      await runSubmitCeremony(claim, {
        approverUserId,
        typedName,
        placement: placement ?? undefined,
      });
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed");
      setBusy(false);
    }
  }

  const placedReady = !hasSignature || !!placement;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" role="dialog">
      <div className="max-h-[92vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-2xl bg-white p-6 sm:rounded-2xl">
        <h3 className="text-lg font-bold">Submit for approval</h3>
        {!enrolled ? (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            Your signing identity isn&apos;t attested yet — enable signing on your{" "}
            <a href="/profile" className="underline">profile</a> and get vouched first.
          </p>
        ) : (
          <>
            <p className="text-sm text-stone-600">
              You&apos;re asking for approval of this claim ({formatCents(claim.totalCents)}).
              Place your signature on the form, pick who should approve it, and sign. If the
              claim changes later, your signature stops counting and approval starts over.
            </p>
            {hasSignature && bytes && anchor && env.me.signatureImage ? (
              <DocumentSignField
                bytes={bytes}
                signatureImage={env.me.signatureImage}
                anchor={anchor}
                onChange={setPlacement}
              />
            ) : hasSignature ? (
              <div className="flex h-40 items-center justify-center rounded-lg border border-stone-200 text-sm text-stone-400">
                Opening the form…
              </div>
            ) : null}
            <label className="block text-sm font-medium">
              Approver
              <select
                className="input mt-1"
                value={approverUserId}
                onChange={(e) => setApproverUserId(e.target.value)}
                data-testid="approver-select"
              >
                <option value="">Choose an approver…</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name} ({m.role})
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium">
              Type your full name to sign
              <input
                className="input mt-1"
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                data-testid="typed-name"
              />
            </label>
            <details className="rounded-lg bg-stone-50 p-3 text-xs text-stone-600">
              <summary className="cursor-pointer font-medium">Electronic records consent</summary>
              <pre className="mt-2 whitespace-pre-wrap">{CONSENT_TEXT}</pre>
            </details>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={affirmed}
                onChange={(e) => setAffirmed(e.target.checked)}
                data-testid="intent-checkbox"
              />
              <span>{INTENT_AFFIRMATION}</span>
            </label>
            {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn-primary disabled:opacity-50"
                disabled={!approverUserId || !typedName.trim() || !affirmed || !placedReady || busy}
                onClick={sign}
                data-testid="sign-submit"
              >
                {busy ? "Signing…" : "Sign & submit"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
