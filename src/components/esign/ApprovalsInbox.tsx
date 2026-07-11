"use client";

/**
 * Approver inbox + decision ceremony (docs/ESIGN_DESIGN.md §6.1–6.2). List
 * rows are mirror state, labeled as such; opening a claim runs the full
 * fail-closed verification — the Approve/Reject buttons enable only when
 * the chain, the naming, and the packet bytes all verify, and the PDF shown
 * IS the verified bytes (blob URL), never a server re-render.
 */

import { useCallback, useEffect, useState } from "react";
import { formatCents } from "@/lib/money";
import { runDecisionCeremony } from "@/lib/esign/client";
import { CONSENT_TEXT, INTENT_AFFIRMATION } from "@/lib/esign/consent";
import { AuditDetails, ThreadSignatures, VerifiedBanner, useClaimChain } from "./chain";
import DocumentSignField from "./DocumentSignField";
import type { SignaturePlacement } from "@/lib/esign/placement";
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

export default function ApprovalsInbox({ endpoint = "/api/approvals", title = "Approvals" }) {
  const [claims, setClaims] = useState<InboxClaim[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(endpoint);
    if (!res.ok) {
      setError((await res.json().catch(() => null))?.error ?? "Could not load");
      return;
    }
    setClaims((await res.json()).claims ?? []);
  }, [endpoint]);
  useEffect(() => {
    void load();
  }, [load]);

  const pending = claims.filter((c) => c.status === "submitted");
  const history = claims.filter((c) => c.status !== "submitted");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="text-sm text-stone-500">
          Open a claim to check it and sign.
        </p>
      </div>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {pending.length === 0 ? (
        <div className="card p-8 text-center text-stone-500">
          <div className="text-3xl">🕊️</div>
          <p className="mt-2">Nothing waiting on you.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {pending.map((c) => (
            <ClaimRow key={c.id} claim={c} open={openId === c.id} onToggle={() => setOpenId(openId === c.id ? null : c.id)} onChanged={load} />
          ))}
        </ul>
      )}

      {history.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-400">
            Decided
          </h2>
          <ul className="space-y-2">
            {history.map((c) => (
              <li key={c.id} className="card flex items-center justify-between p-3 text-sm">
                <span>
                  {c.ownerName} · {formatCents(c.totalCents)}
                </span>
                <StatusChip status={c.status} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function StatusChip({ status }: { status: string }) {
  const styles: Record<string, string> = {
    submitted: "bg-sky-100 text-sky-800",
    approved: "bg-emerald-100 text-emerald-800",
    rejected: "bg-red-100 text-red-800",
    paid: "bg-indigo-100 text-indigo-800",
  };
  const labels: Record<string, string> = {
    submitted: "Awaiting approval",
    approved: "Approved",
    rejected: "Rejected",
    paid: "Paid",
  };
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${styles[status] ?? "bg-stone-100 text-stone-600"}`}>
      {labels[status] ?? status}
    </span>
  );
}

function ClaimRow({
  claim,
  open,
  onToggle,
  onChanged,
}: {
  claim: InboxClaim;
  open: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <li className="card p-4" data-testid={`approval-${claim.id}`}>
      <button className="flex w-full items-center justify-between gap-3 text-left" onClick={onToggle}>
        <div>
          <div className="font-semibold">{claim.ownerName}</div>
          <div className="text-sm text-stone-500">
            {claim.claimDescription || `${claim.rows.length} item(s)`}
            {claim.submittedAt && ` · submitted ${new Date(claim.submittedAt).toLocaleDateString()}`}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold">{formatCents(claim.totalCents)}</span>
          <span className="text-stone-400">{open ? "▾" : "▸"}</span>
        </div>
      </button>
      {open && <DecisionCeremony claim={claim} onChanged={onChanged} />}
    </li>
  );
}

function DecisionCeremony({ claim, onChanged }: { claim: InboxClaim; onChanged: () => Promise<void> }) {
  const { state, error, loading } = useClaimChain(claim);
  const [typedName, setTypedName] = useState("");
  const [comment, setComment] = useState("");
  const [affirmed, setAffirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<SignaturePlacement | null>(null);
  const [placement, setPlacement] = useState<SignaturePlacement | null>(null);

  useEffect(() => {
    if (state && !typedName) setTypedName(state.env.me.name);
  }, [state, typedName]);

  useEffect(() => {
    void fetch(`/api/reimbursements/${claim.id}/sign-anchor`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setAnchor(d.anchor as SignaturePlacement))
      .catch(() => {});
  }, [claim.id]);

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
      setActionError(err instanceof Error ? err.message : "Ceremony failed");
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-3 border-t border-stone-100 pt-4">
      {loading && <p className="text-sm text-stone-500">Verifying the signature chain…</p>}
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {state && (
        <>
          <VerifiedBanner state={state} />
          {!verified && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="failclosed-note">
              Signing is disabled until everything checks out.
            </p>
          )}
          <ThreadSignatures state={state} />
          <div className="grid gap-1 text-sm">
            {claim.rows.map((r, i) => (
              <div key={i} className="flex justify-between gap-3">
                <span className="truncate">{r.description}</span>
                <span className="whitespace-nowrap text-stone-500">
                  {r.ministry}
                  {r.event ? ` — ${r.event}` : ""} · {formatCents(r.amountCents)}
                </span>
              </div>
            ))}
          </div>
          {/* Click-to-stamp on the EXACT verified bytes (never a server
              raster) — placing the approval signature where it goes. */}
          {verified && state.chain.packetBytes && signatureImage && anchor ? (
            <DocumentSignField
              bytes={state.chain.packetBytes}
              signatureImage={signatureImage}
              anchor={anchor}
              onChange={setPlacement}
            />
          ) : state.packetUrl ? (
            <a
              className="text-sm text-indigo-600 underline"
              href={state.packetUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open the verified packet
            </a>
          ) : null}
          <AuditDetails state={state} />
          <label className="block text-sm font-medium">
            Comment (required to reject)
            <input className="input mt-1" value={comment} onChange={(e) => setComment(e.target.value)} data-testid="decision-comment" />
          </label>
          <label className="block text-sm font-medium">
            Type your full name to sign
            <input className="input mt-1" value={typedName} onChange={(e) => setTypedName(e.target.value)} data-testid="decision-typed-name" />
          </label>
          <details className="rounded-lg bg-stone-50 p-3 text-xs text-stone-600">
            <summary className="cursor-pointer font-medium">Electronic records consent</summary>
            <pre className="mt-2 whitespace-pre-wrap">{CONSENT_TEXT}</pre>
          </details>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={affirmed} onChange={(e) => setAffirmed(e.target.checked)} data-testid="decision-intent" />
            <span>{INTENT_AFFIRMATION}</span>
          </label>
          {actionError && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{actionError}</p>}
          <div className="flex justify-end gap-2">
            <button
              className="btn-secondary disabled:opacity-50"
              disabled={!verified || busy || !comment.trim()}
              onClick={() => decide("reject")}
              data-testid="reject-button"
              title={!comment.trim() ? "Add a comment explaining the rejection" : undefined}
            >
              ✗ Reject
            </button>
            <button
              className="btn-primary disabled:opacity-50"
              disabled={
                !verified || busy || !typedName.trim() || !affirmed || (!!signatureImage && !placement)
              }
              onClick={() => decide("approve")}
              data-testid="approve-button"
            >
              {busy ? "Signing…" : "✓ Approve & sign"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
