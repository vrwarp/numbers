"use client";

/**
 * /v/<token> — client-side, from scratch, on every load
 * (docs/ESIGN_DESIGN.md §7.2): replay the roster from the root anchor,
 * verify the claim ledger, hash the archived packet in-browser, and render
 * per-thread ✓/✗. Server-supplied data is INPUT, never verdict. Fresh
 * visitors see the anchor labeled "deployment-pinned" honestly (§4.6).
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { openLedger } from "@/lib/esign/envelope";
import { replayRoster, type RosterTimeline } from "@/lib/esign/roster";
import { evaluateClaimLedger, type ClaimEvaluation } from "@/lib/esign/validity";
import {
  fingerprintDisplay,
  fingerprintMatches,
  keyFingerprint,
  sha256Hex,
} from "@/lib/esign/canonical";
import { formatCents } from "@/lib/money";
import type { ClaimAction, RosterAction, SubmitAction, VerifiedEvent } from "@/lib/esign/types";

interface Verdict {
  anchor: { ok: boolean; label: string };
  roster: RosterTimeline;
  evaluation: ClaimEvaluation;
  packetOk: boolean;
  packetSha256: string | null;
  claimedSha: string | null;
  summary: {
    ownerName?: string;
    totalCents?: number;
    status: string;
    rows?: { description: string; amountCents: number; ministry: string; event: string }[];
  };
  rosterAnomalies: number;
}

const THREAD_STATES = ["open", "approved", "rejected", "paid", "withdrawn", "superseded"] as const;

export default function VerificationView({ token }: { token: string }) {
  const t = useTranslations("Verify");
  const tEsign = useTranslations("Esign");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const get = async (part: string) => {
        const res = await fetch(`/api/v/${token}/${part}`);
        if (!res.ok) throw new Error(t("linkInvalid", { part }));
        return res;
      };
      const summary = await (await get("summary")).json();
      const registry = await (await get("registry")).json();
      const events = await (await get("events")).json();

      // Root anchor: deployment pin when configured; otherwise honestly
      // labeled as server-relayed (fresh visitors have no TOFU state here).
      const rootFp = await keyFingerprint(registry.rootPublicKey);
      const anchor = registry.configuredRootFingerprint
        ? {
            ok: fingerprintMatches(rootFp, registry.configuredRootFingerprint),
            label: t("rootPinnedCfg"),
          }
        : { ok: true, label: t("rootRelayed") };

      const rosterOpen = await openLedger(registry.rosterLedgerKey, events.roster);
      const roster = replayRoster(
        registry.rosterLedgerId,
        rosterOpen.events as VerifiedEvent<RosterAction>[]
      );
      if (roster.root.publicKey !== registry.rootPublicKey) {
        // Audit-grade failure: stays English on purpose (fail-closed detail
        // for whoever investigates, alongside the fingerprints).
        throw new Error("Roster genesis does not match the registry root key");
      }
      const claimOpen = await openLedger(summary.ledgerKey, events.claim);
      const evaluation = evaluateClaimLedger({
        claimId: summary.claimId,
        ledgerId: summary.ledgerId,
        ownerUid: summary.ownerUid,
        roster,
        events: claimOpen.events as VerifiedEvent<ClaimAction>[],
      });

      let packetSha256: string | null = null;
      const packetRes = await fetch(`/api/v/${token}/packet`);
      if (packetRes.ok) {
        packetSha256 = await sha256Hex(new Uint8Array(await packetRes.arrayBuffer()));
      }
      const claimedSha = summary.packetSha256 ?? null;
      const current = claimedSha ? evaluation.currentThread(claimedSha) : undefined;
      const packetOk =
        !!packetSha256 &&
        packetSha256 === claimedSha &&
        !!current?.submit &&
        (current.submit.action as SubmitAction).packetSha256 === packetSha256;

      setVerdict({
        anchor,
        roster,
        evaluation,
        packetOk,
        packetSha256,
        claimedSha,
        summary: {
          ownerName: summary.summary?.ownerName,
          totalCents: summary.summary?.totalCents,
          status: summary.status,
          rows: summary.summary?.rows,
        },
        rosterAnomalies: roster.anomalies.length + rosterOpen.rejected.length,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("failedTitle"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    void run();
  }, [run]);

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl py-10 text-center text-stone-500">
        <div className="text-3xl">🔎</div>
        <p className="mt-2">{t("verifying")}</p>
      </div>
    );
  }
  if (error || !verdict) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="card border-red-300 bg-red-50 p-6 text-red-900" data-testid="verify-error">
          <div className="text-3xl">⛔</div>
          <p className="mt-2 font-semibold">{t("failedTitle")}</p>
          <p className="text-sm">{error}</p>
        </div>
      </div>
    );
  }

  const signerName = (key: string, ts: number) =>
    verdict.roster.memberAt(key, ts)?.name ?? t("unknown");
  const allGreen =
    verdict.anchor.ok && verdict.packetOk && verdict.evaluation.anomalies.length === 0;

  return (
    <div className="mx-auto max-w-2xl space-y-4" data-testid="verification-view">
      <div
        className={`card p-6 ${allGreen ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50"}`}
      >
        <div className="text-3xl">{allGreen ? "✅" : "⚠️"}</div>
        <h1 className="mt-1 text-xl font-bold">
          {allGreen ? t("verifiedTitle") : t("warningsTitle")}
        </h1>
        <p className="text-sm text-stone-600">
          {verdict.summary.ownerName &&
            (verdict.summary.totalCents !== undefined
              ? t.rich("claimByAmountLine", {
                  name: verdict.summary.ownerName,
                  amount: formatCents(verdict.summary.totalCents),
                  b: (chunks) => <strong>{chunks}</strong>,
                })
              : t.rich("claimByLine", {
                  name: verdict.summary.ownerName,
                  b: (chunks) => <strong>{chunks}</strong>,
                }))}
          {t("checkedNow")}
        </p>
      </div>

      <details className="card p-5 text-sm">
        <summary className="cursor-pointer select-none font-medium text-stone-500">
          {tEsign("auditDetails")}
        </summary>
        <div className="mt-3 space-y-2">
        <Check ok={verdict.anchor.ok} label={verdict.anchor.label} />
        <Check
          ok={verdict.packetOk}
          label={
            verdict.packetOk
              ? t("packetMatch", { hash: verdict.packetSha256?.slice(0, 16) ?? "" })
              : t("packetMismatch")
          }
        />
        <Check
          ok={verdict.evaluation.anomalies.length === 0}
          label={
            verdict.evaluation.anomalies.length === 0
              ? t("noAnomalies")
              : t("anomalyCount", { count: verdict.evaluation.anomalies.length })
          }
        />
        {verdict.rosterAnomalies > 0 && (
          <Check ok={false} label={t("rosterOddities", { count: verdict.rosterAnomalies })} />
        )}
        {verdict.evaluation.anomalies.length > 0 && (
          <div>
            <p className="font-semibold text-amber-800">{t("invalidEvents")}</p>
            <ul className="list-inside list-disc text-stone-600">
              {verdict.evaluation.anomalies.map((a, i) => (
                <li key={i}>
                  {(a.event.action as { t?: string }).t}: {a.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-stone-400">
          {t.rich("independentCheckCert", {
            code: (chunks) => <code>{chunks}</code>,
          })}
        </p>
        </div>
      </details>

      {verdict.evaluation.threads.map((th) => (
        <div key={th.seq} className="card space-y-2 p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{t("threadTitle", { seq: th.seq })}</h2>
            <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-700">
              {THREAD_STATES.find((s) => s === th.state)
                ? t(`state.${th.state as (typeof THREAD_STATES)[number]}`)
                : th.state}
            </span>
          </div>
          {th.submit && (
            <SignatureLine
              title={t("submitted")}
              name={signerName(th.submit.signerPublicKey, th.submit.createdAtMs)}
              typed={(th.submit.action as SubmitAction).typedName}
              ts={(th.submit.action as SubmitAction).ts}
              signerKey={th.submit.signerPublicKey}
            />
          )}
          {th.decision && (
            <SignatureLine
              title={th.decision.action.t === "APPROVE" ? t("approved") : t("rejected")}
              name={signerName(th.decision.signerPublicKey, th.decision.createdAtMs)}
              typed={(th.decision.action as { typedName?: string }).typedName}
              ts={(th.decision.action as { ts: number }).ts}
              signerKey={th.decision.signerPublicKey}
              extra={(th.decision.action as { comment?: string }).comment}
            />
          )}
          {th.paid && (
            <SignatureLine
              title={t("paid")}
              name={signerName(th.paid.signerPublicKey, th.paid.createdAtMs)}
              typed={(th.paid.action as { typedName?: string }).typedName}
              ts={(th.paid.action as { ts: number }).ts}
              signerKey={th.paid.signerPublicKey}
              extra={
                (th.paid.action as { checkNumber?: string }).checkNumber
                  ? tEsign("checkNumber", {
                      number: (th.paid.action as { checkNumber?: string }).checkNumber ?? "",
                    })
                  : undefined
              }
            />
          )}
        </div>
      ))}

    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={ok ? "text-emerald-600" : "text-red-600"}>{ok ? "✓" : "✗"}</span>
      <span>{label}</span>
    </div>
  );
}

function SignatureLine({
  title,
  name,
  typed,
  ts,
  signerKey,
  extra,
}: {
  title: string;
  name: string;
  typed?: string;
  ts: number;
  signerKey: string;
  extra?: string;
}) {
  const t = useTranslations("Verify");
  const [fp, setFp] = useState("");
  useEffect(() => {
    void keyFingerprint(signerKey).then((f) => setFp(fingerprintDisplay(f)));
  }, [signerKey]);
  return (
    <div className="rounded-lg bg-stone-50 p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-stone-400">{new Date(ts).toLocaleString()}</span>
      </div>
      <div>
        {typed && <span className="italic">“{typed}” — </span>}
        {name}
      </div>
      {extra && <div className="mt-1 text-xs text-stone-600">{extra}</div>}
      <details className="mt-1 text-[10px] text-stone-400">
        <summary className="cursor-pointer select-none">{t("keySummary")}</summary>
        <code className="font-mono">{fp}</code>
      </details>
    </div>
  );
}
