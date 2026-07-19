"use client";

/**
 * Owner-side e-sign panel on the claim review screen
 * (docs/ESIGN_DESIGN.md §6.1): submit-for-approval ceremony from
 * `generated`, live chain verification + reassignment while `submitted`,
 * the rejection comment + resubmit path, and opening the certificate once
 * approved/paid.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useAutoRefresh } from "@/lib/use-auto-refresh";
import {
  loadEnv,
  runSubmitCeremony,
  withdrawSubmission,
  type EsignEnv,
} from "@/lib/esign/client";
import { CONSENT_TEXT } from "@/lib/esign/consent";
import { formatCents } from "@/lib/money";
import type { SignaturePlacement } from "@/lib/esign/placement";
import { useThrownErrorMessage } from "@/lib/use-api-error";
import { roleLabelKey } from "@/lib/role-label";
import { usePositionLabel } from "@/lib/use-position-label";
import type { PositionNameSet } from "@/lib/positions";
import { APPROVER_PLUS_ROLES } from "@/lib/esign/types";
import ConfirmDialog from "@/components/ConfirmDialog";
import { AuditDetails, ChainAlert, ThreadSignatures, useClaimChain, type ClaimRef } from "./chain";
import { SigningConnectCard, useSigningSession } from "./SigningConnect";
import DocumentSignField from "./DocumentSignField";

export interface EsignClaim extends ClaimRef {
  status: string;
  approverUserId: string | null;
  totalCents: number;
  checkNumber?: string;
  /** Assigned approver's routing availability (server-computed mirror state,
   *  A9/A10) — drives the owner's waiting/reassign notices while submitted. */
  approverInfo?: { name: string; availability: "available" | "paused" | "ineligible" } | null;
  /** Approver to pre-fill from the claim's budget-category default Positions
   *  (server-resolved; null when nothing routes). A suggestion only — the
   *  submitter still picks and signs the approver themselves. */
  suggestedApproverUserId?: string | null;
  suggestedApproverPosition?: PositionNameSet | null;
}

interface Member {
  userId: string;
  name: string;
  email: string;
  role: string;
  // The member's custom approval role (Position), when they hold one; the
  // approver picker labels by this, falling back to `role`. null = none.
  position: PositionNameSet | null;
  approvalsPaused: boolean;
}

export default function EsignPanel({
  claim,
  onChanged,
}: {
  claim: EsignClaim;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations("Esign");
  const [env, setEnv] = useState<EsignEnv | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Withdraw confirms through ConfirmDialog, not window.confirm() — iOS
  // suppresses native dialogs in home-screen (standalone) web apps.
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const signed = ["submitted", "rejected", "approved", "paid"].includes(claim.status);
  // On the owner's review screen the claim's ownerUid IS the signed-in user.
  const chainClaim =
    signed && env ? { ...claim, ownerUid: claim.ownerUid || env.me.userId } : null;
  const { state, error: chainError, refresh, needsConnect, connect, connecting, connectError } =
    useClaimChain(chainClaim);

  useEffect(() => {
    void loadEnv().then(setEnv).catch(() => {});
  }, []);

  // "Awaiting approval" should resolve itself on this screen — poll the mirror
  // (and re-verify the chain) while submitted, so the requester learns of the
  // decision without hammering "Re-check". Paused during dialogs.
  useAutoRefresh(
    () => {
      void onChanged();
      refresh();
    },
    { paused: claim.status !== "submitted" || dialogOpen || withdrawOpen }
  );

  // Master switch (A5): off ⇒ no e-sign affordances anywhere. Already-signed
  // claims still show their status chip, and /v links keep verifying.
  if (!env?.bootstrapped || !env.enabled || env.allowed === false) return null;

  // The `generated` submit-for-approval CTA lives in the review screen's action
  // bar (ReviewClaim), not here — this panel only owns the post-submission
  // states. Keeping both the print/download and the e-sign entry in one bar is
  // what removed the top-banner-vs-bottom-bar split (docs/ESIGN_DESIGN.md §6.1).
  if (!signed) return null;

  const decision = state?.thread?.decision?.action as
    | { t: string; comment?: string }
    | undefined;

  return (
    <div className="card space-y-3 p-4" data-testid="esign-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          {claim.status === "submitted" && t("panelSubmitted")}
          {claim.status === "rejected" && t("panelRejected")}
          {claim.status === "approved" && t("panelApproved")}
          {claim.status === "paid" &&
            (claim.checkNumber
              ? t("panelPaidWithCheck", { checkNumber: claim.checkNumber })
              : t("panelPaid"))}
        </h2>
      </div>
      {/* Who the claim is waiting on, and whether they're still reachable —
          a paused approver may still decide (soft nudge); a demoted/revoked
          one cannot approve anymore (A9), so reassigning is the only way
          forward. The withdraw button below is the existing escape hatch. */}
      {claim.status === "submitted" && claim.approverInfo && (
        <p className="text-sm text-stone-500" data-testid="waiting-approver">
          {t("waitingFor", { name: claim.approverInfo.name })}
        </p>
      )}
      {claim.status === "submitted" && claim.approverInfo?.availability === "paused" && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="approver-paused-note">
          {t("approverPausedNote", { name: claim.approverInfo.name })}
        </p>
      )}
      {claim.status === "submitted" && claim.approverInfo?.availability === "ineligible" && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="approver-ineligible-note">
          {t("approverIneligibleNote", { name: claim.approverInfo.name })}
        </p>
      )}
      {needsConnect && (
        <SigningConnectCard connect={connect} connecting={connecting} error={connectError} />
      )}
      {state && <ChainAlert state={state} />}
      {chainError && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{chainError}</p>}
      {decision?.t === "REJECT" && decision.comment && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="rejection-comment">
          {t("approverComment", { comment: decision.comment })}
        </p>
      )}
      {state && <ThreadSignatures state={state} />}
      {state && <AuditDetails state={state} />}

      <div className="flex flex-wrap gap-2">
        {(claim.status === "approved" || claim.status === "paid") && (
          <a
            className="btn-secondary"
            href={`/api/reimbursements/${claim.id}/certificate`}
            target="_blank"
            rel="noreferrer"
            data-testid="certificate-link"
          >
            {t("certificateLink")}
          </a>
        )}
        {claim.status === "submitted" && state?.thread?.submit && (
          <button
            className="btn-secondary"
            data-testid="change-approver"
            onClick={() => setWithdrawOpen(true)}
          >
            {t("withdrawButton")}
          </button>
        )}
        {claim.status === "rejected" && (
          <button className="btn-primary" onClick={() => setDialogOpen(true)} data-testid="resubmit">
            {t("resubmit")}
          </button>
        )}
        <button className="btn-secondary" onClick={() => refresh()}>
          {t("reverify")}
        </button>
      </div>
      <ConfirmDialog
        open={withdrawOpen}
        message={t("withdrawConfirm")}
        confirmLabel={t("withdrawConfirmButton")}
        busy={withdrawBusy}
        tone="primary"
        onConfirm={async () => {
          // The chain can re-verify while the dialog is up; bail if the
          // submit action is no longer there to withdraw.
          const submit = state?.thread?.submit;
          if (!submit) {
            setWithdrawOpen(false);
            return;
          }
          setWithdrawBusy(true);
          try {
            await withdrawSubmission(
              {
                id: claim.id,
                signatureLedgerId: claim.signatureLedgerId!,
                signatureLedgerKey: claim.signatureLedgerKey!,
              },
              submit.actionHash
            );
            await onChanged();
          } finally {
            setWithdrawBusy(false);
            setWithdrawOpen(false);
          }
        }}
        onCancel={() => setWithdrawOpen(false)}
        testId="withdraw-confirm"
      />
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

export function SubmitDialog({
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
  const t = useTranslations("Esign");
  const tCommon = useTranslations("Common");
  const tRole = useTranslations("Common.role");
  const positionLabel = usePositionLabel();
  const thrown = useThrownErrorMessage();
  const { phase, connect, connecting, error: connectError } = useSigningSession(env);
  const [members, setMembers] = useState<Member[]>([]);
  const [approverUserId, setApproverUserId] = useState("");
  const [typedName, setTypedName] = useState(env.me.name);
  const [affirmed, setAffirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [anchor, setAnchor] = useState<SignaturePlacement | null>(null);
  const [placement, setPlacement] = useState<SignaturePlacement | null>(null);
  // A transient fetch failure must never strand the ceremony on a permanent
  // "Opening the form…" — track it and offer a retry.
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [prepFailed, setPrepFailed] = useState(false);
  const [prepAttempt, setPrepAttempt] = useState(0);
  const enrolled = env.me.identityStatus === "attested";
  const hasSignature = !!env.me.signatureImage;

  useEffect(() => {
    void (async () => {
      setPrepFailed(false);
      try {
        const res = await fetch("/api/esign/members");
        if (!res.ok) throw new Error("members fetch failed");
        const all = ((await res.json()).members ?? []) as Member[];
        // Approver-or-above, not me, and not paused (A10) — the submit
        // preflight re-checks all three server-side.
        const eligible = all.filter(
          (m) =>
            m.userId !== env.me.userId &&
            (APPROVER_PLUS_ROLES as readonly string[]).includes(m.role) &&
            !m.approvalsPaused
        );
        setMembers(eligible);
        setMembersLoaded(true);
        // Pre-fill the budget-category default approver (Positions) when it is
        // a currently-pickable member — a suggestion the submitter can change.
        if (
          claim.suggestedApproverUserId &&
          eligible.some((m) => m.userId === claim.suggestedApproverUserId)
        ) {
          setApproverUserId(claim.suggestedApproverUserId);
        }
        if (enrolled && hasSignature) {
          const [pkt, anc] = await Promise.all([
            fetch(`/api/reimbursements/${claim.id}/packet`),
            fetch(`/api/reimbursements/${claim.id}/sign-anchor`),
          ]);
          if (!pkt.ok || !anc.ok) throw new Error("packet/anchor fetch failed");
          setBytes(await pkt.arrayBuffer());
          setAnchor((await anc.json()).anchor as SignaturePlacement);
        }
      } catch {
        setPrepFailed(true);
      }
    })();
  }, [env.me.userId, claim.id, claim.suggestedApproverUserId, enrolled, hasSignature, prepAttempt]);

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
      setError(thrown(err, t("submissionFailed")));
      setBusy(false);
    }
  }

  const placedReady = !hasSignature || !!placement;
  const roleLabel = (role: string) => {
    const key = roleLabelKey(role);
    return key ? tRole(key) : role;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" role="dialog">
      <div className="max-h-[92vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-2xl bg-white p-6 sm:rounded-2xl">
        <h3 className="text-lg font-bold">{t("submitDialogTitle")}</h3>
        {!enrolled ? (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            {t.rich("notAttested", {
              link: (chunks) => (
                <Link href="/profile" className="underline">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        ) : phase !== "ready" ? (
          // Establish the signing session before showing the sign controls, so
          // the Google popup opens from the connect click and never mid-sign.
          <>
            {phase === "connect" ? (
              <SigningConnectCard connect={connect} connecting={connecting} error={connectError} />
            ) : (
              <p className="text-sm text-stone-500">{tCommon("loading")}</p>
            )}
            <div className="flex justify-end">
              <button className="btn-secondary" onClick={onClose}>
                {tCommon("cancel")}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-stone-600">
              {t("submitIntro", { amount: formatCents(claim.totalCents) })}
            </p>
            {prepFailed && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">
                <span>{t("prepFailed")}</span>
                <button
                  className="font-semibold underline underline-offset-2"
                  onClick={() => setPrepAttempt((n) => n + 1)}
                  data-testid="prep-retry"
                >
                  {t("retryButton")}
                </button>
              </div>
            )}
            {hasSignature && bytes && anchor && env.me.signatureImage ? (
              <DocumentSignField
                bytes={bytes}
                signatureImage={env.me.signatureImage}
                anchor={anchor}
                onChange={setPlacement}
              />
            ) : hasSignature && !prepFailed ? (
              <div className="flex h-40 items-center justify-center rounded-lg border border-stone-200 text-sm text-stone-400">
                {t("openingForm")}
              </div>
            ) : null}
            <label className="block text-sm font-medium">
              {t("approverLabel")}
              <select
                className="input mt-1"
                value={approverUserId}
                onChange={(e) => setApproverUserId(e.target.value)}
                data-testid="approver-select"
              >
                <option value="">{t("approverPlaceholder")}</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {/* Label by the member's Position (custom approval role);
                        fall back to the system role when they hold none. */}
                    {m.name} ({m.position ? positionLabel(m.position) : roleLabel(m.role)})
                  </option>
                ))}
              </select>
            </label>
            {membersLoaded && members.length === 0 && (
              <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="no-approvers-note">
                {t("noEligibleApprovers")}
              </p>
            )}
            {approverUserId &&
              approverUserId === claim.suggestedApproverUserId &&
              claim.suggestedApproverPosition && (
                <p
                  className="rounded-lg bg-indigo-50 p-2 text-xs text-indigo-900"
                  data-testid="approver-prefill-note"
                >
                  {t("approverPrefilledFrom", { position: positionLabel(claim.suggestedApproverPosition) })}
                </p>
              )}
            <label className="block text-sm font-medium">
              {t("typedNameLabel")}
              <input
                className="input mt-1"
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                data-testid="typed-name"
              />
            </label>
            <details className="rounded-lg bg-stone-50 p-3 text-xs text-stone-600">
              <summary className="cursor-pointer font-medium">{t("consentSummary")}</summary>
              {/* The consent document is a hash-bound signed input (consentSha256,
                  docs/ESIGN_DESIGN.md §5.4) — it stays the English ueta-v1 text
                  verbatim; only the chrome around it is localized. */}
              <p className="mt-2 text-stone-400">{t("consentEnglishNote")}</p>
              <pre className="mt-2 whitespace-pre-wrap">{CONSENT_TEXT}</pre>
            </details>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={affirmed}
                onChange={(e) => setAffirmed(e.target.checked)}
                data-testid="intent-checkbox"
              />
              <span>{t("intentAffirmation")}</span>
            </label>
            {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
            {/* Why the button is greyed out — tooltips don't exist on touch. */}
            {hasSignature && bytes && anchor && !placement && !busy && (
              <p className="text-right text-xs text-stone-500" data-testid="submit-place-hint">
                {t("placeSignatureHint")}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={onClose}>
                {tCommon("cancel")}
              </button>
              <button
                className="btn-primary disabled:opacity-50"
                disabled={!approverUserId || !typedName.trim() || !affirmed || !placedReady || busy}
                onClick={sign}
                data-testid="sign-submit"
              >
                {busy ? t("signing") : t("signAndSubmit")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
