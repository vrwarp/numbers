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

export function ChainPills({ state }: { state: ChainState }) {
  const anchorOk = state.chain.anchor.ok;
  const threadOk = !!state.thread?.submit;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="chain-pills">
      <Pill ok={anchorOk} label={anchorOk ? `root pinned (${state.chain.anchor.ok ? state.chain.anchor.pinnedBy : ""})` : "root anchor"} />
      <Pill ok={threadOk} label="signatures verified" />
      <Pill ok={state.packetOk} label="packet bytes match" />
      {state.chain.evaluation.anomalies.length > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
          ⚠ {state.chain.evaluation.anomalies.length} anomal{state.chain.evaluation.anomalies.length === 1 ? "y" : "ies"}
        </span>
      )}
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
  const [fp, setFp] = useState("");
  useEffect(() => {
    void keyFingerprint(signerKey).then((f) => setFp(fingerprintDisplay(f)));
  }, [signerKey]);
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
      <code className="font-mono text-[10px] text-stone-400">{fp}</code>
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
