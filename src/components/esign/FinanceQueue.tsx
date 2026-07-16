"use client";

/**
 * Treasurer queue + mark-paid ceremony (docs/ESIGN_DESIGN.md §6.1–6.2,
 * decision 9): approved claims awaiting payment, each re-verified
 * client-side before the payment signature is possible; paid history with
 * certificate links.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { formatCents } from "@/lib/money";
import { runPaidCeremony } from "@/lib/esign/client";
import { useApiErrorMessage, useThrownErrorMessage } from "@/lib/use-api-error";
import { AuditDetails, ChainAlert, ThreadSignatures, useClaimChain } from "./chain";
import { SigningConnectCard } from "./SigningConnect";
import { StatusChip, type InboxClaim } from "./ApprovalsInbox";

export default function FinanceQueue() {
  const t = useTranslations("Finance");
  const tEsign = useTranslations("Esign");
  const apiError = useApiErrorMessage();
  const [claims, setClaims] = useState<InboxClaim[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/finance");
    if (!res.ok) {
      setError(apiError(await res.json().catch(() => null), tEsign("loadFailed")));
      return;
    }
    setClaims((await res.json()).claims ?? []);
  }, [apiError, tEsign]);
  useEffect(() => {
    void load();
  }, [load]);

  const queue = claims.filter((c) => c.status === "approved");
  const paid = claims.filter((c) => c.status === "paid");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-stone-500">{t("subtitle")}</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {queue.length === 0 ? (
        <div className="card p-8 text-center text-stone-500">
          <div className="text-3xl">🧮</div>
          <p className="mt-2">{t("empty")}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {queue.map((c) => (
            <li key={c.id} className="card card-lift" data-testid={`finance-${c.id}`}>
              <button className="pressable flex w-full items-center justify-between gap-3 p-4 text-left" onClick={() => setOpenId(openId === c.id ? null : c.id)}>
                {/* min-w-0 + truncate so a long claim description shrinks
                    instead of pushing the amount off the card. */}
                <div className="min-w-0">
                  <div className="truncate font-semibold">{c.ownerName}</div>
                  <div className="truncate text-sm text-stone-500">
                    {c.claimDescription ||
                      tEsign("itemsCount", { count: c.rows.length })}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-lg font-bold">{formatCents(c.totalCents)}</span>
                  <span className="text-stone-400">{openId === c.id ? "▾" : "▸"}</span>
                </div>
              </button>
              {openId === c.id && <PaidCeremony claim={c} onChanged={load} />}
            </li>
          ))}
        </ul>
      )}

      {paid.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-400">{t("paidHeader")}</h2>
          <ul className="space-y-2">
            {paid.map((c) => (
              <li key={c.id} className="card flex items-center justify-between p-3 text-sm">
                <span>
                  {c.ownerName} · {formatCents(c.totalCents)}
                </span>
                <div className="flex items-center gap-2">
                  <a className="text-indigo-600 underline" href={`/api/reimbursements/${c.id}/certificate`}>
                    {t("certificate")}
                  </a>
                  <StatusChip status={c.status} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PaidCeremony({ claim, onChanged }: { claim: InboxClaim; onChanged: () => Promise<void> }) {
  const t = useTranslations("Finance");
  const tEsign = useTranslations("Esign");
  const thrown = useThrownErrorMessage();
  const { state, error, loading, needsConnect, connect, connecting, connectError } =
    useClaimChain(claim);
  const [typedName, setTypedName] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [affirmed, setAffirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (state && !typedName) setTypedName(state.env.me.name);
  }, [state, typedName]);

  const thread = state?.thread ?? null;
  const verified =
    !!state &&
    state.chain.anchor.ok &&
    !!thread &&
    thread.state === "approved" &&
    !!thread.decision &&
    state.packetOk;

  async function pay() {
    if (!state || !thread?.decision || !thread.submit) return;
    setBusy(true);
    setActionError(null);
    try {
      await runPaidCeremony(
        {
          id: claim.id,
          signatureLedgerId: claim.signatureLedgerId!,
          signatureLedgerKey: claim.signatureLedgerKey!,
        },
        { checkNumber, typedName },
        {
          approveRef: thread.decision.actionHash,
          packetSha256: (thread.submit.action as { packetSha256: string }).packetSha256,
        }
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
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              {tEsign("failClosed")}
            </p>
          )}
          <ThreadSignatures state={state} />
          <AuditDetails state={state} />
          {/* The approved copy carries the approver's ink/name/date and its
              hash is bound inside the signed APPROVE — the treasurer reviews
              the countersigned form, with the untouched original one click
              away. Pre-feature approvals fall back to the original alone. */}
          {state.approvedPacketUrl ? (
            <div className="flex flex-wrap items-center gap-3">
              <a
                className="btn-secondary inline-block"
                href={state.approvedPacketUrl}
                target="_blank"
                rel="noreferrer"
                data-testid="open-approved-packet"
              >
                {tEsign("openApprovedPacketButton")}
              </a>
              {state.packetUrl && (
                <a
                  className="text-sm text-indigo-600 underline"
                  href={state.packetUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {tEsign("openOriginalPacketLink")}
                </a>
              )}
            </div>
          ) : (
            state.packetUrl && (
              <a className="btn-secondary inline-block" href={state.packetUrl} target="_blank" rel="noreferrer">
                {tEsign("openPacketButton")}
              </a>
            )
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium">
              {t("checkNumberLabel")}
              <input className="input mt-1" value={checkNumber} onChange={(e) => setCheckNumber(e.target.value)} data-testid="check-number" />
            </label>
            <label className="block text-sm font-medium">
              {tEsign("typedNameLabel")}
              <input className="input mt-1" value={typedName} onChange={(e) => setTypedName(e.target.value)} data-testid="paid-typed-name" />
            </label>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={affirmed} onChange={(e) => setAffirmed(e.target.checked)} data-testid="paid-intent" />
            <span>{tEsign("intentAffirmation")}</span>
          </label>
          {actionError && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{actionError}</p>}
          <div className="flex justify-end">
            <button
              className="btn-primary disabled:opacity-50"
              disabled={!verified || busy || !typedName.trim() || !affirmed}
              onClick={pay}
              data-testid="mark-paid-button"
            >
              {busy ? tEsign("signing") : t("signAndMarkPaid")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
