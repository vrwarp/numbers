"use client";

/**
 * Shared client-side chain verification UI (docs/ESIGN_DESIGN.md §2
 * fail-closed rule): a hook that re-derives the full chain — root anchor,
 * roster, thread validity, packet hash — plus the status pills and signature
 * blocks every e-sign view renders. Mirror state is never trusted here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import {
  connectSigningSession,
  hasSigningSession,
  loadEnv,
  preloadSigningSession,
  reconcileClaim,
  verifyClaimChain,
  type ClaimChain,
  type EsignEnv,
} from "@/lib/esign/client";
import { fingerprintDisplay, keyFingerprint, sha256Hex } from "@/lib/esign/canonical";
import { downloadBlob, isStandalonePwa, shareBlob } from "@/lib/pdf-delivery";
import { useThrownErrorMessage } from "@/lib/use-api-error";
import { connectErrorMessage } from "./SigningConnect";
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
  /** The APPROVED COPY (approver ink/name/date stamped on), present only
   *  when its bytes hash to the APPROVE payload's approvedPacketSha256 —
   *  verified-or-absent, like everything else here. */
  approvedPacketUrl: string | null;
  /** Same bytes as the URLs above, kept for standalone-PWA delivery — a
   *  blob: URL in a new tab silently fails there, so links share instead. */
  packetBlob: Blob | null;
  approvedPacketBlob: Blob | null;
}

/**
 * "Open packet"-style link over client-verified bytes. Normal browsers get a
 * blob-URL anchor in a new tab; a standalone (home-screen) PWA gets a button
 * that hands the SAME bytes to the OS share sheet — blob tabs silently fail
 * there, and the bytes are already in memory so the share keeps the tap's
 * user activation.
 */
export function PacketLink({
  url,
  blob,
  filename,
  className,
  children,
  testId,
}: {
  url: string | null;
  blob: Blob | null;
  filename: string;
  className?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  if (isStandalonePwa() && blob) {
    return (
      <button
        type="button"
        className={className}
        onClick={() => {
          void shareBlob(blob, filename).then((outcome) => {
            if (outcome !== "shared") downloadBlob(blob, filename);
          });
        }}
        data-testid={testId}
      >
        {children}
      </button>
    );
  }
  if (!url) return null;
  return (
    <a className={className} href={url} target="_blank" rel="noreferrer" data-testid={testId}>
      {children}
    </a>
  );
}

export function useClaimChain(claim: ClaimRef | null) {
  const t = useTranslations("Esign");
  const thrown = useThrownErrorMessage();
  const [state, setState] = useState<ChainState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "network" failures (couldn't reach the ledger/packet) must never render as
  // the tamper-red integrity alert — they get a neutral retry note instead.
  // Anything ambiguous stays "protocol": neutral must never swallow a real
  // integrity failure.
  const [errorKind, setErrorKind] = useState<"network" | "protocol" | null>(null);
  const [loading, setLoading] = useState(false);
  const [needsConnect, setNeedsConnect] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const envForConnect = useRef<EsignEnv | null>(null);

  // Returns the freshly verified state (null when it couldn't verify) so
  // callers can act on it immediately — React's `state` is stale inside the
  // same closure (e.g. the withdraw pre-check).
  const refresh = useCallback(async (): Promise<ChainState | null> => {
    if (!claim?.signatureLedgerId || !claim.signatureLedgerKey) return null;
    setLoading(true);
    setError(null);
    setErrorKind(null);
    try {
      const env = await loadEnv();
      envForConnect.current = env;
      // Verification reads the ledger backend, which on production Firestore
      // means a Google popup. Don't touch it until this device has a signing
      // session — the connect card establishes one from a click, the only way
      // iOS/Safari lets the popup through.
      await preloadSigningSession(env);
      if (!(await hasSigningSession(env))) {
        setNeedsConnect(true);
        return null;
      }
      setNeedsConnect(false);
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
      const packetBlob = chain.packetBytes
        ? new Blob([chain.packetBytes], { type: "application/pdf" })
        : null;
      const packetUrl = packetBlob ? URL.createObjectURL(packetBlob) : null;
      // Approved copy: fetch by the hash the signed APPROVE carries and
      // re-hash the bytes ourselves — shown only when they agree.
      let approvedPacketUrl: string | null = null;
      let approvedPacketBlob: Blob | null = null;
      const decisionAction = thread?.decision?.action;
      const approvedSha =
        decisionAction?.t === "APPROVE" ? decisionAction.approvedPacketSha256 : undefined;
      if (approvedSha) {
        const copyRes = await fetch(`/api/reimbursements/${claim.id}/packet?sha=${approvedSha}`);
        if (copyRes.ok) {
          const copyBytes = await copyRes.arrayBuffer();
          if ((await sha256Hex(new Uint8Array(copyBytes))) === approvedSha) {
            approvedPacketBlob = new Blob([copyBytes], { type: "application/pdf" });
            approvedPacketUrl = URL.createObjectURL(approvedPacketBlob);
          }
        }
      }
      const next: ChainState = {
        env,
        chain,
        thread,
        packetOk,
        packetUrl,
        approvedPacketUrl,
        packetBlob,
        approvedPacketBlob,
      };
      setState(next);
      // Opportunistic reconciliation (§5.5): fill mirror gaps we can see.
      void reconcileClaim(claim.id, chain.claimDocs).catch(() => {});
      return next;
    } catch (err) {
      // Protocol/audit failures keep their English detail on purpose — this
      // text exists for whoever helps debug a broken chain.
      setError(err instanceof Error ? err.message : "Verification failed");
      setErrorKind(isNetworkError(err) ? "network" : "protocol");
      return null;
    } finally {
      setLoading(false);
    }
  }, [claim?.id, claim?.signatureLedgerId, claim?.signatureLedgerKey, claim?.packetSha256, claim?.submitSeq, claim?.ownerUid]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = useCallback(async () => {
    const env = envForConnect.current;
    if (!env) return;
    setConnecting(true);
    setConnectError(null);
    try {
      await connectSigningSession(env); // gesture-safe popup (warmed on refresh)
      await refresh();
    } catch (err) {
      const message = connectErrorMessage(err, t, thrown);
      if (message) setConnectError(message);
    } finally {
      setConnecting(false);
    }
  }, [refresh, t, thrown]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { state, error, errorKind, loading, refresh, needsConnect, connect, connecting, connectError };
}

/** Transport-shaped failures only — fetch's TypeError, Firestore "unavailable",
 *  offline. Signature/hash mismatches never match (they throw typed messages). */
function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const message = err instanceof Error ? err.message : "";
  const code = (err as { code?: string })?.code ?? "";
  return /unavailable|network|offline|failed to fetch|load failed|timeout/i.test(`${code} ${message}`);
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

/** Surfaces ONLY when something is wrong — a clean chain says nothing on the
 *  main path (the reassurance lives inside AuditDetails, one tap away). Being
 *  silent when all is well keeps verifiability out of a member's face; the red
 *  alert is the only thing that ever needs to interrupt them. */
export function ChainAlert({ state }: { state: ChainState }) {
  const t = useTranslations("Esign");
  if (chainLooksGood(state)) return null;
  return (
    <div
      className="rounded-lg bg-red-50 p-3 text-sm font-medium text-red-900"
      data-testid="chain-alert"
    >
      {t("bannerBad")}
    </div>
  );
}

/** Owner-side manual re-verification, rendered inside AuditDetails — the one
 *  place a skeptic goes to re-run the chain check on demand. */
export interface ReverifyControl {
  run: () => void;
  busy: boolean;
  /** Set when a manual re-run finished with a clean chain — an instant pass
   *  must still visibly acknowledge the press. */
  verifiedAt: Date | null;
}

/** The cryptographic detail regular members never need — one tap away for
 *  whoever is auditing (docs/ESIGN_DESIGN.md UX rule: technical material
 *  lives behind a disclosure, never on the main path). Opens with the
 *  plain-language "everything checks out" line, then the technical evidence. */
export function AuditDetails({ state, reverify }: { state: ChainState; reverify?: ReverifyControl }) {
  const t = useTranslations("Esign");
  const format = useFormatter();
  const ok = chainLooksGood(state);
  const anchorOk = state.chain.anchor.ok;
  const threadOk = !!state.thread?.submit;
  const anomalies = state.chain.evaluation.anomalies;
  return (
    <details
      className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600"
      data-testid="audit-details"
    >
      <summary className="cursor-pointer select-none font-medium text-stone-500">
        {t("auditDetails")}
      </summary>
      <div className="mt-2 space-y-2">
        <p
          className={`font-medium ${ok ? "text-emerald-800" : "text-red-800"}`}
          data-testid="audit-status"
        >
          {ok ? t("bannerOk") : t("bannerBad")}
        </p>
        <div className="flex flex-wrap gap-1.5" data-testid="chain-pills">
          <Pill
            ok={anchorOk}
            label={anchorOk ? t("pillRootPinned", { by: state.chain.anchor.pinnedBy }) : t("pillRootFailed")}
          />
          <Pill ok={threadOk} label={t("pillChain")} />
          <Pill ok={state.packetOk} label={t("pillPacket")} />
        </div>
        {!anchorOk && "reason" in state.chain.anchor && (
          <p className="text-red-700">{state.chain.anchor.reason}</p>
        )}
        <SignerFingerprints state={state} />
        {anomalies.length > 0 && (
          <div>
            <p className="font-medium text-amber-700">
              {t("anomaliesHeader", { count: anomalies.length })}
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
        {reverify && (
          <div className="flex flex-wrap items-center gap-2" aria-live="polite">
            {reverify.busy ? (
              <p className="text-stone-500">{t("verifyingChain")}</p>
            ) : (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={reverify.run}
                  data-testid="verify-again"
                >
                  {t("verifyAgain")}
                </button>
                {reverify.verifiedAt && (
                  <span className="font-medium text-emerald-700" data-testid="verified-at">
                    {t("verifiedAtTime", {
                      time: format.dateTime(reverify.verifiedAt, { timeStyle: "short" }),
                    })}
                  </span>
                )}
              </>
            )}
          </div>
        )}
        <p className="text-stone-400">
          {t.rich("independentCheck", {
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      </div>
    </details>
  );
}

function SignerFingerprints({ state }: { state: ChainState }) {
  const t = useTranslations("Esign");
  const [rows, setRows] = useState<{ name: string; fp: string }[]>([]);
  useEffect(() => {
    void (async () => {
      const th = state.thread;
      if (!th?.submit) return;
      const events = [th.submit, th.decision, th.paid].filter(Boolean);
      const out: { name: string; fp: string }[] = [];
      for (const e of events) {
        const member = state.chain.roster.memberAt(e!.signerPublicKey, e!.createdAtMs);
        out.push({
          name: member?.name ?? t("unknownMember"),
          fp: fingerprintDisplay(await keyFingerprint(e!.signerPublicKey)),
        });
      }
      setRows(out);
    })();
  }, [state, t]);
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="font-medium">{t("signerFingerprints")}</p>
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
  const t = useTranslations("Esign");
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
        {member?.name ?? t("unknownSigner")}
      </div>
      {extra && <div className="mt-1 text-xs text-stone-600">{extra}</div>}
    </div>
  );
}

export function ThreadSignatures({ state }: { state: ChainState }) {
  const t = useTranslations("Esign");
  const thread = state.thread;
  const blocks = useMemo(() => {
    if (!thread?.submit) return [];
    const submit = thread.submit.action as SubmitAction;
    const out: React.ComponentProps<typeof SignatureBlock>[] = [
      {
        title: t("blockSubmitted", { seq: thread.seq }),
        typedName: submit.typedName,
        signerKey: thread.submit.signerPublicKey,
        roster: state.chain.roster,
        ts: submit.ts,
      },
    ];
    if (thread.decision) {
      const d = thread.decision.action as { t: string; typedName?: string; ts: number; comment?: string };
      out.push({
        title: d.t === "APPROVE" ? t("blockApproved") : t("blockRejected"),
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
        title: t("blockPaid"),
        typedName: p.typedName,
        signerKey: thread.paid.signerPublicKey,
        roster: state.chain.roster,
        ts: p.ts,
        extra: p.checkNumber ? t("checkNumber", { number: p.checkNumber }) : undefined,
      });
    }
    return out;
  }, [thread, state.chain.roster, t]);
  if (blocks.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="thread-signatures">
      {blocks.map((b, i) => (
        <SignatureBlock key={i} {...b} />
      ))}
    </div>
  );
}
