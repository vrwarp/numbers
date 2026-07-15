"use client";

/**
 * /v/<token> — client-side, from scratch, on every load
 * (docs/ESIGN_DESIGN.md §7.2): replay the roster from the root anchor,
 * verify the claim ledger, hash the archived packet in-browser, and tell
 * the WHOLE story to whoever scanned the QR — who signed (and who vouched
 * for them, walkable to the root), the sealed document versions at each
 * step, and that nothing changed. Server-supplied data is INPUT, never
 * verdict. Fresh visitors see the anchor labeled "deployment-pinned" (§4.6).
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { openLedger } from "@/lib/esign/envelope";
import { replayRoster, type RosterMember, type RosterTimeline } from "@/lib/esign/roster";
import { evaluateClaimLedger, type ClaimEvaluation, type Thread } from "@/lib/esign/validity";
import {
  fingerprintDisplay,
  fingerprintMatches,
  keyFingerprint,
  sha256Hex,
} from "@/lib/esign/canonical";
import { formatCents } from "@/lib/money";
import type {
  ApproveAction,
  ClaimAction,
  RosterAction,
  SubmitAction,
  VerifiedEvent,
} from "@/lib/esign/types";

interface Signer {
  publicKey: string;
  ts: number;
  tag: "requested" | "approved" | "paid";
}

interface Verdict {
  anchor: { ok: boolean; label: string };
  roster: RosterTimeline;
  evaluation: ClaimEvaluation;
  current?: Thread;
  packetOk: boolean;
  packetSha256: string | null;
  claimedSha: string | null;
  approvedSha: string | null;
  signers: Signer[];
  /** publicKey → 8-byte display fingerprint, precomputed for sync render. */
  fingerprints: Record<string, string>;
  summary: { ownerName?: string; totalCents?: number; status: string };
  rosterAnomalies: number;
}

const AVATAR = ["bg-teal-600", "bg-violet-600", "bg-pink-600", "bg-blue-600", "bg-orange-600"];
function avatarClass(uid: string): string {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0;
  return AVATAR[h % AVATAR.length];
}
function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "?"
  );
}

export default function VerificationView({ token }: { token: string }) {
  const t = useTranslations("Verify");
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
        // Audit-grade failure — stays English for whoever investigates.
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

      // Signers of the current thread (the ones this certificate is about).
      const signers: Signer[] = [];
      if (current?.submit)
        signers.push({ publicKey: current.submit.signerPublicKey, ts: current.submit.createdAtMs, tag: "requested" });
      if (current?.decision?.action.t === "APPROVE")
        signers.push({ publicKey: current.decision.signerPublicKey, ts: current.decision.createdAtMs, tag: "approved" });
      if (current?.paid)
        signers.push({ publicKey: current.paid.signerPublicKey, ts: current.paid.createdAtMs, tag: "paid" });

      const approvedSha =
        current?.decision?.action.t === "APPROVE"
          ? (current.decision.action as ApproveAction).approvedPacketSha256 ?? null
          : null;

      // Precompute display fingerprints for every roster key (chain nodes
      // render synchronously off this map).
      const fingerprints: Record<string, string> = {};
      for (const m of roster.members) {
        if (!fingerprints[m.publicKey]) {
          fingerprints[m.publicKey] = fingerprintDisplay(await keyFingerprint(m.publicKey));
        }
      }

      setVerdict({
        anchor,
        roster,
        evaluation,
        current,
        packetOk,
        packetSha256,
        claimedSha,
        approvedSha,
        signers,
        fingerprints,
        summary: {
          ownerName: summary.summary?.ownerName,
          totalCents: summary.summary?.totalCents,
          status: summary.status,
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
      <div className="mx-auto max-w-xl py-10 text-center text-stone-500">
        <div className="text-3xl">🔎</div>
        <p className="mt-2">{t("verifying")}</p>
      </div>
    );
  }
  if (error || !verdict) {
    return (
      <div className="mx-auto max-w-xl">
        <div className="card border-red-300 bg-red-50 p-6 text-red-900" data-testid="verify-error">
          <div className="text-3xl">⛔</div>
          <p className="mt-2 font-semibold">{t("failedTitle")}</p>
          <p className="text-sm">{error}</p>
        </div>
      </div>
    );
  }

  const allGreen =
    verdict.anchor.ok && verdict.packetOk && verdict.evaluation.anomalies.length === 0;
  const state = verdict.current?.state;
  const storyKey = !allGreen
    ? "warn"
    : state === "paid"
      ? "paid"
      : state === "approved"
        ? "approved"
        : state === "rejected"
          ? "rejected"
          : "submitted";
  const amount =
    verdict.summary.totalCents !== undefined ? formatCents(verdict.summary.totalCents) : "";

  return (
    <div className="mx-auto max-w-xl space-y-4" data-testid="verification-view">
      {/* VERDICT */}
      <div
        className={`card p-6 text-center ${allGreen ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50"}`}
      >
        <div
          className={`mx-auto grid h-12 w-12 place-items-center rounded-full text-white ${allGreen ? "bg-emerald-600" : "bg-amber-600"}`}
        >
          {allGreen ? <CheckIcon className="h-7 w-7" /> : <AlertIcon className="h-7 w-7" />}
        </div>
        <h1 className={`mt-3 text-xl font-extrabold ${allGreen ? "text-stone-900" : "text-amber-900"}`}>
          {allGreen ? t("confirmedTitle") : t("warningsTitle")}
        </h1>
        {verdict.summary.ownerName ? (
          <p className="mx-auto mt-1 max-w-md text-sm text-stone-600">
            {t.rich(`story.${storyKey}`, {
              name: verdict.summary.ownerName,
              amount,
              b: (c) => <strong className="font-semibold text-stone-800">{c}</strong>,
            })}
          </p>
        ) : (
          <p className="mt-1 text-sm text-stone-600">{t("storyGeneric")}</p>
        )}
        <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-1 text-xs text-stone-600">
          <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600" />
          {t("checkedNow")}
        </span>
      </div>

      {/* PILLS */}
      <div className="grid grid-cols-4 gap-2" aria-label={t("pillsLabel")}>
        <Pill status={verdict.current?.submit ? "ok" : "muted"} label={t("pillRequested")} />
        <Pill
          status={state === "approved" || state === "paid" ? "ok" : state === "rejected" ? "bad" : "muted"}
          label={t("pillApproved")}
        />
        <Pill status={state === "paid" ? "ok" : "muted"} label={t("pillPaid")} />
        <Pill status={verdict.packetOk ? "ok" : "bad"} label={t("pillUnchanged")} />
      </div>

      {/* PEOPLE / CHAIN OF TRUST */}
      {verdict.signers.length > 0 && (
        <section>
          <Eyebrow>{t("peopleTitle")}</Eyebrow>
          <p className="mb-2 px-1 text-xs text-stone-600">{t("peopleHint")}</p>
          <div className="card divide-y divide-stone-100">
            {dedupeSigners(verdict.signers).map((s) => (
              <TrustNode
                key={s.publicKey}
                member={verdict.roster.members.find((m) => m.publicKey === s.publicKey)}
                fallbackKey={s.publicKey}
                depth={0}
                tag={s.tag}
                verdict={verdict}
              />
            ))}
          </div>
        </section>
      )}

      {/* DOCUMENT — what you're holding */}
      {verdict.summary.ownerName && (verdict.approvedSha || verdict.claimedSha) && (
        <section>
          <Eyebrow>{t("docTitle")}</Eyebrow>
          <div className="card flex items-center gap-4 p-4">
            <a
              href={`/api/v/${token}/packet?sha=${verdict.approvedSha ?? verdict.claimedSha}`}
              target="_blank"
              rel="noopener noreferrer"
              className="grid h-[76px] w-[58px] flex-none place-items-center rounded-md border border-stone-300 bg-white text-stone-400 shadow-sm transition hover:border-indigo-300 hover:text-indigo-500"
              aria-label={t("docOpen")}
            >
              <DocIcon className="h-7 w-7" />
            </a>
            <div className="text-sm">
              <span className={`block font-semibold ${allGreen ? "text-stone-900" : "text-red-700"}`}>
                {allGreen ? t("docLeadOk") : t("docLeadWarn")}
              </span>
              <span className="text-stone-600">{allGreen ? t("docBodyOk") : t("docBodyWarn")}</span>
              <a
                href={`/api/v/${token}/packet?sha=${verdict.approvedSha ?? verdict.claimedSha}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block font-semibold text-indigo-600 hover:text-indigo-700"
              >
                {t("docOpen")} →
              </a>
            </div>
          </div>
        </section>
      )}

      {/* STEP BY STEP + SEALED VERSIONS */}
      {verdict.current && (
        <section>
          <Eyebrow>{t("stepsTitle")}</Eyebrow>
          <div className="card px-4 py-2">
            <Steps token={token} verdict={verdict} />
          </div>
        </section>
      )}

      {/* LOCK LINE */}
      <div className="flex items-start gap-2 px-1 text-xs text-stone-600">
        <LockIcon className="mt-0.5 h-4 w-4 flex-none text-emerald-600" />
        <span>{t("lockLine")}</span>
      </div>

      {/* AUDITOR DRAWER */}
      <details className="card p-4 text-sm">
        <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wide text-stone-500">
          {t("forAuditors")}
        </summary>
        <div className="mt-3 space-y-2 text-stone-600">
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
              <ul className="list-inside list-disc">
                {verdict.evaluation.anomalies.map((a, i) => (
                  <li key={i}>
                    {(a.event.action as { t?: string }).t}: {a.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-stone-400">
            {t.rich("independentCheckCert", { code: (c) => <code>{c}</code> })}
          </p>
        </div>
      </details>
    </div>
  );
}

/* ---------------------------------------------------------------- pieces -- */

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
      {children}
    </p>
  );
}

function Pill({ status, label }: { status: "ok" | "bad" | "muted"; label: string }) {
  const cls =
    status === "ok"
      ? "bg-emerald-50 text-emerald-700"
      : status === "bad"
        ? "bg-red-50 text-red-700"
        : "bg-stone-100 text-stone-400";
  const Icon = status === "bad" ? AlertIcon : status === "muted" ? DashIcon : CheckIcon;
  return (
    <div className={`flex flex-col items-center gap-1.5 rounded-lg px-1 py-2.5 ${cls}`}>
      <Icon className="h-4 w-4" />
      <span className="text-[11px] font-semibold text-stone-600">{label}</span>
    </div>
  );
}

function dedupeSigners(signers: Signer[]): Signer[] {
  const seen = new Set<string>();
  return signers.filter((s) => (seen.has(s.publicKey) ? false : (seen.add(s.publicKey), true)));
}

/**
 * One node of the walkable chain of trust. depth 0 = a signer on this claim,
 * depth 1 = a direct voucher (named), depth ≥ 2 = an earlier link shown by
 * key only (privacy — deeper up the chain the KEY is the identity, the name
 * is a convenience label). Every branch terminates at the root anchor.
 */
function TrustNode({
  member,
  fallbackKey,
  depth,
  tag,
  verdict,
}: {
  member: RosterMember | undefined;
  fallbackKey: string;
  depth: number;
  tag?: Signer["tag"];
  verdict: Verdict;
}) {
  const t = useTranslations("Verify");
  const [open, setOpen] = useState(false);
  const publicKey = member?.publicKey ?? fallbackKey;
  const isRoot = publicKey === verdict.roster.root.publicKey;
  const fp = verdict.fingerprints[publicKey] ?? "";
  const named = depth <= 1;

  if (isRoot) {
    return (
      <div>
        <div className="flex items-center gap-3 rounded-lg bg-emerald-50 p-2.5">
          <span className="grid h-8 w-8 flex-none place-items-center rounded-full bg-emerald-600 text-white">
            <AnchorIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-stone-900">{t("rootName")}</div>
            <div className="font-mono text-[11px] text-stone-500">{fp}</div>
          </div>
        </div>
        <p className="ml-12 mt-1 mb-1.5 text-[11px] leading-snug text-stone-600">{t("rootCaption")}</p>
      </div>
    );
  }

  const vouchers = member?.vouchedBy ?? [];
  const canOpen = vouchers.length > 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => canOpen && setOpen((v) => !v)}
        aria-expanded={canOpen ? open : undefined}
        className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-stone-50"
      >
        {named ? (
          <span
            className={`grid flex-none place-items-center rounded-full text-white ${depth === 0 ? "h-9 w-9 text-sm" : "h-[30px] w-[30px] text-xs"} ${avatarClass(member?.uid ?? publicKey)}`}
          >
            {initials(member?.name ?? "?")}
          </span>
        ) : (
          <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-full border border-dashed border-stone-300 text-stone-400">
            <PersonIcon className="h-4 w-4" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          {named ? (
            <>
              <span className="text-sm font-semibold text-stone-900">{member?.name ?? t("personByKey")}</span>
              {depth === 0 && tag && (
                <span className="text-xs font-normal text-stone-500"> · {t(`tag.${tag}`)}</span>
              )}
              {depth === 0 && (
                <span className="mt-0.5 flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
                  <CheckIcon className="h-3 w-3" /> {t("confirmedInPerson")}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="block text-sm font-semibold text-stone-600">{t("personByKey")}</span>
              <span className="font-mono text-[11px] text-stone-500">{fp}</span>
            </>
          )}
        </span>
        {canOpen && <ChevronIcon className={`h-4 w-4 flex-none text-stone-400 transition ${open ? "rotate-180" : ""}`} />}
      </button>
      {canOpen && open && (
        <div className="ml-[21px] border-l-2 border-stone-100 pl-4">
          <div className="mt-1.5 mb-0.5 flex items-center gap-1.5 pl-2 text-[10px] font-semibold uppercase tracking-wide text-stone-400">
            <UpIcon className="h-3 w-3" /> {t("confirmedByLabel")}
          </div>
          {vouchers.map((v) => (
            <TrustNode
              key={v.publicKey}
              member={verdict.roster.members.find((m) => m.publicKey === v.publicKey)}
              fallbackKey={v.publicKey}
              depth={depth + 1}
              verdict={verdict}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Steps({ token, verdict }: { token: string; verdict: Verdict }) {
  const t = useTranslations("Verify");
  const th = verdict.current!;
  const rows: React.ReactNode[] = [];

  const nameFor = (key: string, ts: number) => verdict.roster.memberAt(key, ts)?.name ?? t("unknown");

  if (th.submit) {
    const a = th.submit.action as SubmitAction;
    rows.push(
      <Step
        key="submit"
        title={t("stepSubmit")}
        subtitle={t("submitted")}
        ts={a.ts}
        how={t("howSubmit", { name: nameFor(th.submit.signerPublicKey, th.submit.createdAtMs) })}
      >
        <VersionChip
          token={token}
          tag={t("vtagOriginal")}
          sha={a.packetSha256}
          cap={t.rich("vcapOriginal", { b: (c) => <strong className="font-semibold text-stone-800">{c}</strong> })}
        />
      </Step>
    );
  }
  if (th.decision) {
    const approve = th.decision.action.t === "APPROVE";
    const a = th.decision.action as { ts: number; comment?: string; approvedPacketSha256?: string };
    rows.push(
      <Step
        key="decision"
        title={approve ? t("stepApprove") : t("stepReject")}
        subtitle={approve ? t("approved") : t("rejected")}
        ts={a.ts}
        how={t("howApprove")}
        quote={a.comment || undefined}
        bad={!approve}
      >
        {approve && a.approvedPacketSha256 && (
          <VersionChip
            token={token}
            tag={t("vtagApproved")}
            sha={a.approvedPacketSha256}
            cap={t.rich("vcapApproved", { b: (c) => <strong className="font-semibold text-stone-800">{c}</strong> })}
          />
        )}
      </Step>
    );
  }
  if (th.paid) {
    const a = th.paid.action as { ts: number; checkNumber?: string };
    rows.push(
      <Step
        key="paid"
        title={t("stepPaid")}
        subtitle={t("paid")}
        ts={a.ts}
        how={a.checkNumber ? t("howPaidCheck", { number: a.checkNumber }) : t("howPaid")}
      >
        <VersionChip token={token} tag={t("vtagNone")} muted cap={t("vcapNone")} />
      </Step>
    );
  }
  return <>{rows}</>;
}

function Step({
  title,
  subtitle,
  ts,
  how,
  quote,
  bad,
  children,
}: {
  title: string;
  subtitle: string;
  ts: number;
  how: string;
  quote?: string;
  bad?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative border-b border-stone-100 py-3.5 pl-8 last:border-0">
      <span
        className={`absolute left-0.5 top-4 grid h-5 w-5 place-items-center rounded-full text-white shadow-[0_0_0_3px_white] ${bad ? "bg-red-600" : "bg-emerald-600"}`}
      >
        {bad ? <AlertIcon className="h-3 w-3" /> : <CheckIcon className="h-3 w-3" />}
      </span>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-stone-900">
          {title} <span className="font-medium text-stone-400">— {subtitle}</span>
        </span>
        <span className="whitespace-nowrap text-[11px] tabular-nums text-stone-400">
          {new Date(ts).toLocaleString()}
        </span>
      </div>
      <div className="mt-1 flex gap-1.5 text-xs text-stone-600">
        <span aria-hidden className="mt-0.5">·</span>
        <span>{how}</span>
      </div>
      {quote && (
        <div className="mt-2 border-l-2 border-stone-300 pl-2.5 text-xs italic text-stone-600">
          “{quote}”
        </div>
      )}
      {children}
    </div>
  );
}

function VersionChip({
  token,
  tag,
  sha,
  cap,
  muted,
}: {
  token: string;
  tag: string;
  sha?: string;
  cap: React.ReactNode;
  muted?: boolean;
}) {
  const t = useTranslations("Verify");
  return (
    <div
      className={`mt-2.5 flex gap-2.5 rounded-lg p-2.5 ${muted ? "border border-dashed border-stone-200" : "border border-stone-200 bg-stone-50"}`}
    >
      {muted ? (
        <span className="grid w-[30px] flex-none place-items-center text-stone-400">
          <BackIcon className="h-5 w-5" />
        </span>
      ) : (
        <span className="grid h-11 w-[34px] flex-none place-items-center rounded border border-stone-300 bg-white text-stone-400 shadow-sm">
          <DocIcon className="h-5 w-5" />
        </span>
      )}
      <div className="min-w-0">
        <span
          className={`mb-1 inline-block rounded px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ${muted ? "border border-stone-300 text-stone-400" : "bg-indigo-50 text-indigo-700"}`}
        >
          {tag}
        </span>
        <div className="text-xs leading-snug text-stone-600">{cap}</div>
        {sha && (
          <details className="mt-1.5">
            <summary className="inline-flex cursor-pointer items-center gap-1 text-[11px] font-semibold text-indigo-600">
              <SearchIcon className="h-3 w-3" /> {t("viewPage")}
            </summary>
            <div className="mt-1 space-y-0.5 text-[11px] text-stone-500">
              <div>
                {t("markLabel")} <span className="font-mono text-stone-700">{fingerprintDisplay(sha)}</span>
              </div>
              <a
                href={`/api/v/${token}/packet?sha=${sha}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-indigo-600 hover:text-indigo-700"
              >
                {t("openThisPage")} →
              </a>
            </div>
          </details>
        )}
      </div>
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

/* ------------------------------------------------------------------ icons -- */
type IconProps = { className?: string };
const CheckIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className}><path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const CheckCircleIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className}><path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" /></svg>
);
const AlertIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className}><path d="M12 8v5m0 3h.01M10.3 4.3L2.5 18a2 2 0 001.7 3h15.6a2 2 0 001.7-3L13.7 4.3a2 2 0 00-3.4 0z" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const DashIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className}><path d="M6 12h12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
);
const ChevronIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className}><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const UpIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className}><path d="M12 19V5M6 11l6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const PersonIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className}><circle cx="12" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.7" /><path d="M5.5 20a6.5 6.5 0 0113 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
);
const AnchorIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className}><circle cx="12" cy="5" r="2.4" stroke="currentColor" strokeWidth="1.8" /><path d="M12 7.4V21M6 12H4a8 8 0 0016 0h-2M8.5 10.5h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const LockIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className}><rect x="4" y="10" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" /><path d="M8 10V7a4 4 0 018 0v3" stroke="currentColor" strokeWidth="1.8" /></svg>
);
const DocIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className}><path d="M6 2h8l4 4v16H6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M14 2v4h4M9 13h6M9 17h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
);
const BackIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className}><path d="M9 14l-4-4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><path d="M5 10h9a5 5 0 015 5v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const SearchIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className}><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" /><path d="M20 20l-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
);
