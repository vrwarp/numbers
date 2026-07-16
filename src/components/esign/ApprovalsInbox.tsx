"use client";

/**
 * Approver inbox + decision ceremony (docs/ESIGN_DESIGN.md §6.1–6.2). List
 * rows are mirror state, labeled as such; opening a claim runs the full
 * fail-closed verification — the Approve/Reject buttons enable only when
 * the chain, the naming, and the packet bytes all verify, and the PDF shown
 * IS the verified bytes (blob URL), never a server re-render.
 */

import { useCallback, useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { formatCents } from "@/lib/money";
import { runDecisionCeremony } from "@/lib/esign/client";
import { CONSENT_TEXT } from "@/lib/esign/consent";
import { useApiErrorMessage, useThrownErrorMessage } from "@/lib/use-api-error";
import { AuditDetails, ChainAlert, ThreadSignatures, useClaimChain } from "./chain";
import ConfirmDialog from "./ConfirmDialog";
import { SigningConnectCard } from "./SigningConnect";
import DocumentSignField, { type TextStamp } from "./DocumentSignField";
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
  rows: { description: string; amountCents: number; ministry: string; event: string }[];
}

/** Own-eligibility context from /api/approvals (A9/A10) — mirror state; the
 *  decision route and ledger validity enforce it regardless of what renders. */
interface InboxMe {
  approvalsPaused: boolean;
  canApprove: boolean;
}

export default function ApprovalsInbox({ endpoint = "/api/approvals" }: { endpoint?: string }) {
  const t = useTranslations("Approvals");
  const tEsign = useTranslations("Esign");
  const apiError = useApiErrorMessage();
  const [claims, setClaims] = useState<InboxClaim[]>([]);
  const [me, setMe] = useState<InboxMe | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
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

  const pending = claims.filter((c) => c.status === "submitted");
  const history = claims.filter((c) => c.status !== "submitted");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-stone-500">{t("subtitle")}</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
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

      {pending.length === 0 ? (
        <div className="card p-8 text-center text-stone-500">
          <div className="text-3xl">🕊️</div>
          <p className="mt-2">{t("empty")}</p>
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
          <ul className="space-y-2">
            {history.map((c) => (
              <li key={c.id} className="card flex items-center justify-between gap-3 p-3 text-sm">
                <span className="min-w-0 truncate">
                  {c.ownerName} · {formatCents(c.totalCents)}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {(c.status === "approved" || c.status === "paid") && (
                    <a
                      className="text-indigo-600 underline"
                      href={`/api/reimbursements/${c.id}/certificate`}
                      data-testid={`certificate-${c.id}`}
                    >
                      {tEsign("certificateLink")}
                    </a>
                  )}
                  <StatusChip status={c.status} />
                </span>
              </li>
            ))}
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
  const t = useTranslations("Approvals");
  const tEsign2 = useTranslations("Esign");
  const format = useFormatter();
  return (
    <li className="card card-lift" data-testid={`approval-${claim.id}`}>
      <button className="pressable flex w-full items-center justify-between gap-3 p-4 text-left" onClick={onToggle}>
        {/* min-w-0 + truncate so a long claim description shrinks instead of
            pushing the amount off the card (flex min-width:auto). */}
        <div className="min-w-0">
          <div className="truncate font-semibold">{claim.ownerName}</div>
          <div className="truncate text-sm text-stone-500">
            {claim.claimDescription || tEsign2("itemsCount", { count: claim.rows.length })}
            {claim.submittedAt &&
              ` · ${t("submittedOn", {
                date: format.dateTime(new Date(claim.submittedAt), {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                }),
              })}`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-lg font-bold">{formatCents(claim.totalCents)}</span>
          <span className="text-stone-400">{open ? "▾" : "▸"}</span>
        </div>
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
  const [nameField, setNameField] = useState<FieldAnchor | null>(null);
  const [dateField, setDateField] = useState<FieldAnchor | null>(null);
  const [placement, setPlacement] = useState<SignaturePlacement | null>(null);
  // The date the certificate route stamps is the signing time — "today" here.
  const [today] = useState(() => {
    const d = new Date();
    return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
  });

  useEffect(() => {
    if (state && !typedName) setTypedName(state.env.me.name);
  }, [state, typedName]);

  useEffect(() => {
    void fetch(`/api/reimbursements/${claim.id}/sign-anchor`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setAnchor(d.anchor as SignaturePlacement);
        setNameField((d.nameField as FieldAnchor | null) ?? null);
        setDateField((d.dateField as FieldAnchor | null) ?? null);
      })
      .catch(() => {});
  }, [claim.id]);

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
      setActionError(thrown(err, tEsign("ceremonyFailed")));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-stone-100 px-4 pb-4 pt-4">
      {needsConnect && (
        <SigningConnectCard connect={connect} connecting={connecting} error={connectError} />
      )}
      {loading && <p className="text-sm text-stone-500">{tEsign("verifyingChain")}</p>}
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {state && (
        <>
          <ChainAlert state={state} />
          {!verified && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="failclosed-note">
              {tEsign("failClosed")}
            </p>
          )}
          <ThreadSignatures state={state} />
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
          {state.packetUrl && (
            <a
              className="btn-secondary inline-block self-start"
              href={state.packetUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="open-packet"
            >
              {tEsign("openPacketButton")}
            </a>
          )}
          {/* Click-to-stamp on the EXACT verified bytes (never a server
              raster) — placing the approval signature where it goes, with the
              printed name + date the certificate stamps alongside it. */}
          {verified && state.chain.packetBytes && signatureImage && anchor ? (
            <DocumentSignField
              bytes={state.chain.packetBytes}
              signatureImage={signatureImage}
              anchor={anchor}
              onChange={setPlacement}
              textStamps={signStamps}
            />
          ) : null}
          <AuditDetails state={state} />
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
          <div className="flex justify-end gap-2">
            <button
              className="btn-secondary disabled:opacity-50"
              disabled={!verified || busy || !comment.trim()}
              onClick={() => setConfirmReject(true)}
              data-testid="reject-button"
              title={!comment.trim() ? t("rejectNeedsComment") : undefined}
            >
              {t("reject")}
            </button>
            <button
              className="btn-primary disabled:opacity-50"
              // canApprove: role-at-exercise (A9) — a demoted approver may
              // still reject above, and the server/ledger refuse regardless.
              disabled={
                !verified ||
                !canApprove ||
                busy ||
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
      )}
    </div>
  );
}
