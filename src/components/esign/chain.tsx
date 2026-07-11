"use client";

/**
 * Shared client-side chain verification UI (docs/ESIGN_DESIGN.md §2
 * fail-closed rule): a hook that re-derives the full chain — root anchor,
 * roster, thread validity, packet hash — plus the status pills and signature
 * blocks every e-sign view renders. Mirror state is never trusted here.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadEnv,
  reconcileClaim,
  verifyClaimChain,
  type ClaimChain,
  type EsignEnv,
} from "@/lib/esign/client";
import { fingerprintDisplay, keyFingerprint } from "@/lib/esign/canonical";
import type { Thread } from "@/lib/esign/validity";
import type { SubmitAction } from "@/lib/esign/types";

export interface ClaimRef {
  id: string;
  ownerUid: string;
  signatureLedgerId: string | null;
  signatureLedgerKey: string | null;
  packetSha256: string | null;
  submitSeq: number;
}

export interface ChainState {
  env: EsignEnv;
  chain: ClaimChain;
  /** The thread the mirror claims is current, verified. */
  thread: Thread | null;
  /** True when fetched bytes hash to the SUBMIT's (and mirror's) sha. */
  packetOk: boolean;
  packetUrl: string | null;
}

export function useClaimChain(claim: ClaimRef | null) {
  const [state, setState] = useState<ChainState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!claim?.signatureLedgerId || !claim.signatureLedgerKey) return;
    setLoading(true);
    setError(null);
    try {
      const env = await loadEnv();
      const chain = await verifyClaimChain(env, {
        id: claim.id,
        ownerUid: claim.ownerUid,
        signatureLedgerId: claim.signatureLedgerId,
        signatureLedgerKey: claim.signatureLedgerKey,
        packetSha256: claim.packetSha256,
      });
      const thread = chain.evaluation.threads.find((t) => t.seq === claim.submitSeq) ?? null;
      const submitSha = thread?.submit ? (thread.submit.action as SubmitAction).packetSha256 : null;
      const packetOk =
        !!chain.packetSha256 &&
        chain.packetSha256 === claim.packetSha256 &&
        (!submitSha || submitSha === chain.packetSha256);
      const packetUrl = chain.packetBytes
        ? URL.createObjectURL(new Blob([chain.packetBytes], { type: "application/pdf" }))
        : null;
      setState({ env, chain, thread, packetOk, packetUrl });
      // Opportunistic reconciliation (§5.5): fill mirror gaps we can see.
      void reconcileClaim(claim.id, chain.claimDocs).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }, [claim?.id, claim?.signatureLedgerId, claim?.signatureLedgerKey, claim?.packetSha256, claim?.submitSeq, claim?.ownerUid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { state, error, loading, refresh };
}

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        ok ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
      }`}
    >
      {ok ? "✓" : "✗"} {label}
    </span>
  );
}

/** Everything a regular member needs to know, in one sentence. */
export function chainLooksGood(state: ChainState): boolean {
  return (
    state.chain.anchor.ok &&
    !!state.thread?.submit &&
    state.packetOk &&
    state.chain.evaluation.anomalies.length === 0
  );
}

export function VerifiedBanner({ state }: { state: ChainState }) {
  const ok = chainLooksGood(state);
  return (
    <div
      className={`rounded-lg p-3 text-sm font-medium ${
        ok ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-900"
      }`}
      data-testid="verified-banner"
    >
      {ok
        ? "✓ Everything checks out — this is the genuine paperwork, unchanged."
        : "✗ Something doesn't check out. Don't sign — ask the person who sent this (details below for whoever helps you)."}
    </div>
  );
}

/** The cryptographic detail regular members never need — one tap away for
 *  whoever is auditing (docs/ESIGN_DESIGN.md UX rule: technical material
 *  lives behind a disclosure, never on the main path). */
export function AuditDetails({ state }: { state: ChainState }) {
  const anchorOk = state.chain.anchor.ok;
  const threadOk = !!state.thread?.submit;
  const anomalies = state.chain.evaluation.anomalies;
  return (
    <details className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600">
      <summary className="cursor-pointer select-none font-medium text-stone-500">
        Audit details
      </summary>
      <div className="mt-2 space-y-2">
        <div className="flex flex-wrap gap-1.5" data-testid="chain-pills">
          <Pill ok={anchorOk} label={anchorOk ? `root pinned (${state.chain.anchor.pinnedBy})` : "root anchor FAILED"} />
          <Pill ok={threadOk} label="signature chain" />
          <Pill ok={state.packetOk} label="packet bytes" />
        </div>
        {!anchorOk && "reason" in state.chain.anchor && (
          <p className="text-red-700">{state.chain.anchor.reason}</p>
        )}
        <SignerFingerprints state={state} />
        {anomalies.length > 0 && (
          <div>
            <p className="font-medium text-amber-700">
              {anomalies.length} invalid event(s) on the ledger (kept visible, never hidden):
            </p>
            <ul className="list-inside list-disc">
              {anomalies.map((a, i) => (
                <li key={i}>
                  {(a.event.action as { t?: string }).t}: {a.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-stone-400">
          Independent check: download the certificate and run{" "}
          <code className="font-mono">scripts/verify-bundle.mjs</code> with the church&apos;s
          published root fingerprint.
        </p>
      </div>
    </details>
  );
}

function SignerFingerprints({ state }: { state: ChainState }) {
  const [rows, setRows] = useState<{ name: string; fp: string }[]>([]);
  useEffect(() => {
    void (async () => {
      const t = state.thread;
      if (!t?.submit) return;
      const events = [t.submit, t.decision, t.paid].filter(Boolean);
      const out: { name: string; fp: string }[] = [];
      for (const e of events) {
        const member = state.chain.roster.memberAt(e!.signerPublicKey, e!.createdAtMs);
        out.push({
          name: member?.name ?? "unknown",
          fp: fingerprintDisplay(await keyFingerprint(e!.signerPublicKey)),
        });
      }
      setRows(out);
    })();
  }, [state]);
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="font-medium">Signer key fingerprints:</p>
      {rows.map((r, i) => (
        <div key={i}>
          {r.name}: <code className="font-mono">{r.fp}</code>
        </div>
      ))}
    </div>
  );
}

function SignatureBlock({
  title,
  typedName,
  signerKey,
  roster,
  ts,
  extra,
}: {
  title: string;
  typedName?: string;
  signerKey: string;
  roster: ChainState["chain"]["roster"];
  ts?: number;
  extra?: string;
}) {
  const member = roster.members.find((m) => m.publicKey === signerKey);
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-semibold">{title}</span>
        {ts ? (
          <span className="text-xs text-stone-400">{new Date(ts).toLocaleString()}</span>
        ) : null}
      </div>
      <div className="mt-1">
        {typedName && <span className="font-medium italic">“{typedName}” — </span>}
        {member?.name ?? "Unknown signer"}
      </div>
      {extra && <div className="mt-1 text-xs text-stone-600">{extra}</div>}
    </div>
  );
}

export function ThreadSignatures({ state }: { state: ChainState }) {
  const thread = state.thread;
  const blocks = useMemo(() => {
    if (!thread?.submit) return [];
    const submit = thread.submit.action as SubmitAction;
    const out: React.ComponentProps<typeof SignatureBlock>[] = [
      {
        title: `Submitted (seq ${thread.seq})`,
        typedName: submit.typedName,
        signerKey: thread.submit.signerPublicKey,
        roster: state.chain.roster,
        ts: submit.ts,
      },
    ];
    if (thread.decision) {
      const d = thread.decision.action as { t: string; typedName?: string; ts: number; comment?: string };
      out.push({
        title: d.t === "APPROVE" ? "Approved" : "Rejected",
        typedName: d.typedName,
        signerKey: thread.decision.signerPublicKey,
        roster: state.chain.roster,
        ts: d.ts,
        extra: d.comment ? `“${d.comment}”` : undefined,
      });
    }
    if (thread.paid) {
      const p = thread.paid.action as { typedName?: string; ts: number; checkNumber?: string };
      out.push({
        title: "Paid",
        typedName: p.typedName,
        signerKey: thread.paid.signerPublicKey,
        roster: state.chain.roster,
        ts: p.ts,
        extra: p.checkNumber ? `Check #${p.checkNumber}` : undefined,
      });
    }
    return out;
  }, [thread, state.chain.roster]);
  if (blocks.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="thread-signatures">
      {blocks.map((b, i) => (
        <SignatureBlock key={i} {...b} />
      ))}
    </div>
  );
}
