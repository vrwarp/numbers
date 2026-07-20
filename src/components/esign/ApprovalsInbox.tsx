"use client";

/**
 * Approver inbox + decision ceremony (docs/ESIGN_DESIGN.md §6.1–6.2). List
 * rows are mirror state, labeled as such; opening a claim runs the full
 * fail-closed verification — the Approve/Reject buttons enable only when
 * the chain, the naming, and the packet bytes all verify, and the PDF shown
 * IS the verified bytes (blob URL), never a server re-render.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useOpenParam } from "@/lib/use-open-param";
import { useAutoRefresh } from "@/lib/use-auto-refresh";
import { useTimeZone, useTranslations } from "next-intl";
import { formatCents } from "@/lib/money";
import { DEFAULT_TIME_ZONE, formatDateMMDDYYYY } from "@/lib/timezone";
import ClaimSummaryRow from "./ClaimSummaryRow";
import { LedgerCommittedError, runDecisionCeremony, warmClaimVerification } from "@/lib/esign/client";
import { CONSENT_TEXT } from "@/lib/esign/consent";
import { useApiErrorMessage, useThrownErrorMessage } from "@/lib/use-api-error";
import { AuditDetails, ChainAlert, PacketLink, ThreadSignatures, chainLooksGood, useClaimChain } from "./chain";
import ConfirmDialog from "./ConfirmDialog";
import { SigningConnectCard } from "./SigningConnect";
import DocumentSignField, { type TextStamp } from "./DocumentSignField";
import PdfLink from "@/components/PdfLink";
import type { FieldAnchor, SignaturePlacement } from "@/lib/esign/placement";
import type { SubmitAction } from "@/lib/esign/types";

export interface InboxClaim {
  id: string;
  status: string;
  ownerName: string;
  ownerUid: string;
  claimDescription: string;
  totalCents: number;
  packetSha256: string | null;
  signatureLedgerId: string | null;
  signatureLedgerKey: string | null;
  submitSeq: number;
  submittedAt: string | null;
  decidedAt: string | null;
  paidAt: string | null;
  checkNumber: string | null;
  rows: { description: string; amountCents: number; ministry: string; event: string }[];
}

/** Own-eligibility context from /api/approvals (A9/A10) — mirror state; the
 *  decision route and ledger validity enforce it regardless of what renders. */
interface InboxMe {
  approvalsPaused: boolean;
  canApprove: boolean;
  identityStatus: string | null;
}

export default function ApprovalsInbox({ endpoint = "/api/approvals" }: { endpoint?: string }) {
  const t = useTranslations("Approvals");
  const tEsign = useTranslations("Esign");
  const tCommon = useTranslations("Common");
  const apiError = useApiErrorMessage();
  // null = first load still in flight — don't flash the empty state.
  const [claims, setClaims] = useState<InboxClaim[] | null>(null);
  const [me, setMe] = useState<InboxMe | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = claims ?? [];
  // ?open=<id> deep link from search results (shared contract,
  // src/lib/use-open-param.ts): expand a submitted row, pulse a decided one.
  const [openGone, setOpenGone] = useState(false);
  useOpenParam({
    ready: claims !== null,
    exists: (id) => list.some((c) => c.id === id),
    beforeScroll: (id) => {
      if (list.find((c) => c.id === id)?.status === "submitted") setOpenId(id);
    },
    onGone: () => setOpenGone(true),
  });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(endpoint);
    if (!res.ok) {
      setError(apiError(await res.json().catch(() => null), tEsign("loadFailed")));
      return;
    }
    const data = await res.json();
    setClaims(data.claims ?? []);
    setMe(data.me ?? null);
  }, [endpoint, apiError, tEsign]);
  useEffect(() => {
    void load();
  }, [load]);
  // Warm the signing stack (Firebase SDK, restored session, verified roster)
  // while the approver is still reading the list — opening a claim then only
  // waits on the claim ledger and the packet bytes.
  useEffect(() => {
    void warmClaimVerification();
  }, []);
  // A submitted claim should appear without a manual reload — but never
  // refresh under an open decision ceremony.
  useAutoRefresh(load, { paused: openId !== null });

  const pending = list.filter((c) => c.status === "submitted");
  const history = list.filter((c) => c.status !== "submitted");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-stone-500">{t("subtitle")}</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {openGone && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800" role="status" data-testid="open-gone-toast">
          {t("openGone")}
        </p>
      )}
      {/* Grandfathered work while paused (A10): claims assigned before the
          pause stay decidable — say so instead of leaving a silent pile. */}
      {me?.approvalsPaused && me.canApprove && pending.length > 0 && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="paused-notice">
          {t("pausedNotice")}
        </p>
      )}
      {/* Role revoked (A9): approving is off the table — declining is not. */}
      {me && !me.canApprove && pending.length > 0 && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="role-lost-notice">
          {t("roleLostNotice")}
        </p>
      )}

      {claims === null ? (
        <p className="text-sm text-stone-500">{tCommon("loading")}</p>
      ) : pending.length === 0 ? (
        // Backstop branches (docs/ESIGN_SETUP_DISCOVERABILITY.md §3.8): a
        // role-holder whose identity is mid-transition (re-enrolling, revoked)
        // learns WHY nothing arrives — the bare dove is for people whose inbox
        // could actually receive work. Revoked stays neutral: the profile card
        // owns that story, never a cheerful setup pitch.
        <div className="card p-8 text-center text-stone-500">
          {me && me.identityStatus !== "attested" && <div className="mb-2 text-3xl">✍️</div>}
          {me && me.identityStatus !== "attested" ? (
            me.identityStatus === "revoked" ? (
              <p data-testid="empty-revoked">
                {t.rich("emptyRevoked", {
                  link: (chunks) => (
                    <Link href="/profile" className="text-indigo-600 underline">
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            ) : me.identityStatus === "pending" ? (
              <p data-testid="empty-pending-vouch">
                {t.rich("emptyPendingVouch", {
                  link: (chunks) => (
                    <Link href="/profile?open=esign" className="text-indigo-600 underline">
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            ) : (
              <p data-testid="empty-not-set-up">
                {t.rich("emptyNotSetUp", {
                  link: (chunks) => (
                    <Link href="/profile?open=esign" className="text-indigo-600 underline">
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            )
          ) : (
            <>
              <div className="text-3xl">🕊️</div>
              <p className="mt-2">{t("empty")}</p>
            </>
          )}
        </div>
      ) : (
        <ul className="space-y-3">
          {pending.map((c) => (
            <ClaimRow
              key={c.id}
              claim={c}
              canApprove={me?.canApprove ?? true}
              open={openId === c.id}
              onToggle={() => setOpenId(openId === c.id ? null : c.id)}
              onChanged={load}
            />
          ))}
        </ul>
      )}

      {history.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-400">
            {t("decided")}
          </h2>
          <ul className="space-y-3">
            {history.map((c) => {
              // Approved/paid claims have a certificate (signature cover page +
              // full signed packet + offline verification bundle); a rejected
              // claim has none, so its row falls back to the signed submission
              // packet. Both are served inline, so the row opens the PDF in its
              // own tab and leaves the inbox put.
              const hasCertificate = c.status === "approved" || c.status === "paid";
              return (
                <li key={c.id} className="card card-lift" data-testid={`decided-${c.id}`} data-open-id={c.id}>
                  <PdfLink
                    className="pressable block rounded-xl p-4"
                    href={
                      hasCertificate
                        ? `/api/reimbursements/${c.id}/certificate`
                        : `/api/reimbursements/${c.id}/packet`
                    }
                    filename={`cfcc-${hasCertificate ? "certificate" : "reimbursement"}-${c.id}.pdf`}
                    testId={`decided-open-${c.id}`}
                  >
                    <ClaimSummaryRow claim={c} trailing={<StatusChip status={c.status} />} />
                  </PdfLink>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export function StatusChip({ status }: { status: string }) {
  const tStatus = useTranslations("Common.status");
  const styles: Record<string, string> = {
    submitted: "bg-sky-100 text-sky-800",
    approved: "bg-emerald-100 text-emerald-800",
    rejected: "bg-red-100 text-red-800",
    paid: "bg-indigo-100 text-indigo-800",
  };
  const known = (["submitted", "approved", "rejected", "paid"] as const).find(
    (k) => k === status
  );
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${styles[status] ?? "bg-stone-100 text-stone-600"}`}>
      {known ? tStatus(known) : status}
    </span>
  );
}

function ClaimRow({
  claim,
  canApprove,
  open,
  onToggle,
  onChanged,
}: {
  claim: InboxClaim;
  canApprove: boolean;
  open: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <li className="card card-lift" data-testid={`approval-${claim.id}`} data-open-id={claim.id}>
      <button className="pressable block w-full p-4 text-left" onClick={onToggle}>
        <ClaimSummaryRow
          claim={claim}
          trailing={<span className="text-stone-400">{open ? "▾" : "▸"}</span>}
        />
      </button>
      {open && <DecisionCeremony claim={claim} canApprove={canApprove} onChanged={onChanged} />}
    </li>
  );
}

function DecisionCeremony({
  claim,
  canApprove,
  onChanged,
}: {
  claim: InboxClaim;
  canApprove: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useTranslations("Approvals");
  const tEsign = useTranslations("Esign");
  const thrown = useThrownErrorMessage();
  const { state, error, loading, needsConnect, connect, connecting, connectError } =
    useClaimChain(claim);
  const [typedName, setTypedName] = useState("");
  const [comment, setComment] = useState("");
  const [affirmed, setAffirmed] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<SignaturePlacement | null>(null);
  const [anchorFailed, setAnchorFailed] = useState(false);
  const [anchorAttempt, setAnchorAttempt] = useState(0);
  // Ledger holds the decision but the mirror lagged — lock out a re-sign.
  const [committed, setCommitted] = useState(false);
  // Tapping a disabled Approve/Reject reveals the first missing requirement.
  const [attempted, setAttempted] = useState(false);
  const [nameField, setNameField] = useState<FieldAnchor | null>(null);
  const [dateField, setDateField] = useState<FieldAnchor | null>(null);
  const [placement, setPlacement] = useState<SignaturePlacement | null>(null);
  // The date the certificate route stamps is the signing time — "today" here,
  // in the app time zone so the preview matches the server-stamped copy.
  const timeZone = useTimeZone() ?? DEFAULT_TIME_ZONE;
  const [today] = useState(() => formatDateMMDDYYYY(new Date(), timeZone));

  const prefilled = useRef(false);
  useEffect(() => {
    // Prefill once when verification lands — re-filling on every render
    // would fight a deliberate clear of the field.
    if (state && !prefilled.current) {
      prefilled.current = true;
      if (!typedName) setTypedName(state.env.me.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    setAnchorFailed(false);
    void fetch(`/api/reimbursements/${claim.id}/sign-anchor`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // Without the anchor the stamp surface never renders and Approve
        // stays disabled — surface the failure instead of hanging forever.
        if (!d) {
          setAnchorFailed(true);
          return;
        }
        setAnchor(d.anchor as SignaturePlacement);
        setNameField((d.nameField as FieldAnchor | null) ?? null);
        setDateField((d.dateField as FieldAnchor | null) ?? null);
      })
      .catch(() => setAnchorFailed(true));
  }, [claim.id, anchorAttempt]);

  // Printed name + date the approver's signature fills alongside the ink — the
  // same values the certificate route bakes onto the delivery copy.
  const signStamps: TextStamp[] = [
    nameField && { key: "name", text: typedName, field: nameField },
    dateField && { key: "date", text: today, field: dateField },
  ].filter(Boolean) as TextStamp[];

  const signatureImage = state?.env.me.signatureImage ?? null;

  const thread = state?.thread ?? null;
  const submit = thread?.submit?.action as SubmitAction | undefined;
  const verified =
    !!state &&
    state.chain.anchor.ok &&
    !!thread &&
    thread.state === "open" &&
    !!submit &&
    submit.approverUid === state.env.me.userId &&
    state.packetOk;

  async function decide(decision: "approve" | "reject") {
    if (!state || !thread?.submit) return;
    setBusy(true);
    setActionError(null);
    try {
      await runDecisionCeremony(
        {
          id: claim.id,
          signatureLedgerId: claim.signatureLedgerId!,
          signatureLedgerKey: claim.signatureLedgerKey!,
        },
        { decision, comment, typedName, placement: placement ?? undefined },
        { submitRef: thread.submit.actionHash, packetSha256: submit!.packetSha256 }
      );
      await onChanged();
    } catch (err) {
      if (err instanceof LedgerCommittedError) {
        // The decision IS signed on the ledger — retrying would double-sign.
        // Lock the buttons, say so, and refresh (reconciliation catches up).
        setCommitted(true);
        setActionError(tEsign("signedButNotSynced"));
        await onChanged();
      } else {
        setActionError(thrown(err, tEsign("ceremonyFailed")));
      }
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-stone-100 px-4 pb-4 pt-4">
      {needsConnect && (
        <SigningConnectCard connect={connect} connecting={connecting} error={connectError} />
      )}
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {state && (
        <>
          <ChainAlert state={state} />
          {/* One warning at a time: when the chain itself is bad, ChainAlert's
              red banner already says "don't sign" — the amber note would just
              stack a vaguer duplicate under it. When the chain is FINE but
              signing is still blocked, name the actual reason if we can. */}
          {!verified && chainLooksGood(state) && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="failclosed-note">
              {thread && thread.state !== "open"
                ? tEsign("alreadyDecidedNote")
                : submit && submit.approverUid !== state.env.me.userId
                  ? tEsign("assignedElsewhereNote")
                  : tEsign("failClosed")}
            </p>
          )}
          <ThreadSignatures state={state} />
        </>
      )}
      {/* From here down the ceremony renders OPTIMISTICALLY from mirror data
          while the chain verifies: the approver can read the rows and fill in
          the form during the check. Nothing signable leaks — Approve/Reject
          stay disabled until `verified`, and a failed check lands as the red
          error above. */}
      <>
          <div className="grid gap-2 text-sm sm:gap-1">
            {claim.rows.map((r, i) => (
              // Mobile: stack — the full description wraps on its own line, the
              // ministry + amount sit below it (truncating a receipt summary to
              // "COSTCO WHO…" tells an approver nothing). From sm: up there's
              // room for one row, so it collapses to description | ministry ·
              // amount, where the description truncates and the amount is the
              // never-truncated tail. min-w-0 at every level so the desktop
              // truncation actually engages (grid + flex items default to
              // min-width:auto and would otherwise overflow the card).
              <div
                key={i}
                className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3"
                data-testid={`inbox-row-${i}`}
              >
                <span className="break-words sm:min-w-0 sm:flex-1 sm:truncate">{r.description}</span>
                <span className="text-stone-500 sm:flex sm:min-w-0 sm:max-w-[55%] sm:shrink-0 sm:items-baseline sm:whitespace-nowrap">
                  <span className="sm:min-w-0 sm:truncate">
                    {r.ministry}
                    {r.event ? ` — ${r.event}` : ""}
                  </span>
                  <span className="whitespace-nowrap">{` · ${formatCents(r.amountCents)}`}</span>
                </span>
              </div>
            ))}
          </div>
          {/* The stamp surface previews only the first form page; this opens the
              whole packet — every form page plus the appended receipts — so the
              approver can review what they're signing. */}
          {state && (
            <PacketLink
              className="btn-secondary inline-block self-start"
              url={state.packetUrl}
              blob={state.packetBlob}
              filename={`cfcc-reimbursement-${claim.id}.pdf`}
              testId="open-packet"
            >
              {tEsign("openPacketButton")}
            </PacketLink>
          )}
          {/* Click-to-stamp on the EXACT verified bytes (never a server
              raster) — placing the approval signature where it goes, with the
              printed name + date the certificate stamps alongside it. */}
          {state && verified && state.chain.packetBytes && signatureImage && anchor ? (
            <DocumentSignField
              bytes={state.chain.packetBytes}
              signatureImage={signatureImage}
              anchor={anchor}
              onChange={setPlacement}
              textStamps={signStamps}
            />
          ) : verified && signatureImage && anchorFailed ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">
              <span>{tEsign("prepFailed")}</span>
              <button
                className="font-semibold underline underline-offset-2"
                onClick={() => setAnchorAttempt((n) => n + 1)}
                data-testid="anchor-retry"
              >
                {tEsign("retryButton")}
              </button>
            </div>
          ) : loading ? (
            // The paperwork check runs behind this placeholder (where the
            // stamp surface will appear) instead of blanking the whole form.
            <div
              className="flex h-40 items-center justify-center rounded-lg border border-dashed border-stone-200 bg-stone-50 text-sm text-stone-500"
              data-testid="verify-pending"
            >
              {tEsign("verifyingChain")}
            </div>
          ) : null}
          {state && <AuditDetails state={state} />}
          <label className="block text-sm font-medium">
            {t("commentLabel")}
            <input className="input mt-1" value={comment} onChange={(e) => setComment(e.target.value)} data-testid="decision-comment" />
          </label>
          <label className="block text-sm font-medium">
            {tEsign("typedNameLabel")}
            <input className="input mt-1" value={typedName} onChange={(e) => setTypedName(e.target.value)} data-testid="decision-typed-name" />
          </label>
          <details className="rounded-lg bg-stone-50 p-3 text-xs text-stone-600">
            <summary className="cursor-pointer font-medium">{tEsign("consentSummary")}</summary>
            {/* Hash-bound English ueta-v1 text — see EsignPanel's note. */}
            <p className="mt-2 text-stone-400">{tEsign("consentEnglishNote")}</p>
            <pre className="mt-2 whitespace-pre-wrap">{CONSENT_TEXT}</pre>
          </details>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={affirmed} onChange={(e) => setAffirmed(e.target.checked)} data-testid="decision-intent" />
            <span>{tEsign("intentAffirmation")}</span>
          </label>
          {actionError && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{actionError}</p>}
          {/* Why the buttons are greyed out — tooltips don't exist on touch.
              The signature-placement case shows unprompted; the rest reveal on
              a tap of a disabled button. */}
          {(() => {
            const reason = busy || committed || !verified
              ? null
              : !!signatureImage && !placement
                ? tEsign("placeSignatureHint")
                : !typedName.trim()
                  ? tEsign("hintTypeName")
                  : !affirmed
                    ? tEsign("hintAffirm")
                    : !comment.trim() && !canApprove
                      ? t("rejectNeedsComment")
                      : null;
            const unprompted = !!signatureImage && !placement;
            return reason && (attempted || unprompted) ? (
              <p className="text-right text-xs text-stone-500" data-testid="place-signature-hint">
                {reason}
              </p>
            ) : null;
          })()}
          {attempted && !busy && !committed && verified && affirmed && typedName.trim() && !comment.trim() && (
            <p className="text-right text-xs text-stone-500" data-testid="reject-comment-hint">
              {t("rejectNeedsComment")}
            </p>
          )}
          <div
            className="flex justify-end gap-2"
            onClick={() => {
              if (!busy && !committed) setAttempted(true);
            }}
          >
            <button
              className="btn-secondary disabled:pointer-events-none disabled:opacity-50"
              // A REJECT is signed into the ledger exactly like an APPROVE —
              // it carries the same intent affirmation.
              disabled={!verified || busy || committed || !comment.trim() || !affirmed || !typedName.trim()}
              onClick={() => setConfirmReject(true)}
              data-testid="reject-button"
              title={!comment.trim() ? t("rejectNeedsComment") : undefined}
            >
              {t("reject")}
            </button>
            <button
              className="btn-primary disabled:pointer-events-none disabled:opacity-50"
              // canApprove: role-at-exercise (A9) — a demoted approver may
              // still reject above, and the server/ledger refuse regardless.
              disabled={
                !verified ||
                !canApprove ||
                busy ||
                committed ||
                !typedName.trim() ||
                !affirmed ||
                (!!signatureImage && !placement)
              }
              onClick={() => decide("approve")}
              data-testid="approve-button"
              title={!canApprove ? t("roleLostNotice") : undefined}
            >
              {busy ? tEsign("signing") : t("approveAndSign")}
            </button>
          </div>
          {/* Reject is a one-way door for the approver: the decision route only
              acts while status is `submitted`, so once rejected they can never
              re-open or re-approve — only the owner can revise and resubmit.
              Spell that out before committing (the backend gate is the real
              guard; this is the humane warning the quiet button lacked). */}
          {confirmReject && (
            <ConfirmDialog
              title={t("rejectConfirmTitle")}
              confirmLabel={t("rejectConfirmAction")}
              danger
              busy={busy}
              error={actionError}
              onConfirm={() => decide("reject")}
              onCancel={() => setConfirmReject(false)}
            >
              <p>{t("rejectConfirmBody", { name: claim.ownerName })}</p>
            </ConfirmDialog>
          )}
      </>
    </div>
  );
}
