"use client";

/**
 * Members & roster (docs/ADMIN.md): the day-to-day verified-mirror table
 * (role, enrollment, rollout allowlist, activity) plus the e-sign master
 * switch/scope, and the cryptographic vouch-for chain rendered client-side
 * from the roster ledger (the admin is the enrolled root). The switch reuses
 * PATCH /api/esign/registry; allowlist reuses PATCH /api/esign/allowlist.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useDateLabel } from "@/lib/use-date-label";
import { loadEnv, loadRoster, type EsignEnv } from "@/lib/esign/client";
import type { RosterTimeline } from "@/lib/esign/roster";
import { useThrownErrorMessage } from "@/lib/use-api-error";
import { roleLabelKey } from "@/lib/role-label";
import { SigningGate } from "@/components/esign/SigningConnect";

interface Member {
  userId: string;
  email: string;
  name: string;
  role: string;
  allowed: boolean;
  identityStatus: string | null;
  hasKey: boolean;
  attestedAt: string | null;
  receipts: number;
  claims: number;
}

const ROLE_STYLE: Record<string, string> = {
  admin: "bg-indigo-100 text-indigo-700",
  treasurer: "bg-purple-100 text-purple-700",
  chairman: "bg-amber-100 text-amber-700",
  secretary: "bg-emerald-100 text-emerald-700",
  approver: "bg-sky-100 text-sky-700",
  member: "bg-stone-100 text-stone-500",
};

export default function MembersTab() {
  const t = useTranslations("Admin");
  const tRole = useTranslations("Common.role");
  const thrown = useThrownErrorMessage();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [env, setEnv] = useState<EsignEnv | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const roleLabel = (r: string) => {
    const key = roleLabelKey(r);
    return key ? tRole(key) : r;
  };

  const loadMembers = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/members");
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
      setMembers(((await res.json()) as { members: Member[] }).members);
    } catch (err) {
      setError(thrown(err, t("loadFailed")));
    }
  }, [t, thrown]);

  useEffect(() => {
    void loadMembers();
    void loadEnv().then(setEnv).catch(() => {});
  }, [loadMembers]);

  async function toggleAllowed(m: Member, allowed: boolean) {
    setBusyId(m.userId);
    try {
      const res = await fetch("/api/esign/allowlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: m.userId, allowed }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
      setMembers((prev) => prev?.map((u) => (u.userId === m.userId ? { ...u, allowed } : u)) ?? prev);
    } catch (err) {
      setError(thrown(err, t("saveFailed")));
    } finally {
      setBusyId(null);
    }
  }

  async function patchRegistry(patch: { enabled?: boolean; scope?: string }) {
    const res = await fetch("/api/esign/registry", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
    setEnv((e) => (e ? { ...e, ...patch, scope: (patch.scope as EsignEnv["scope"]) ?? e.scope } : e));
  }

  const bootstrapped = !!env?.bootstrapped;
  const enabled = !!env?.enabled;
  const scope = env?.scope ?? "allowlist";

  return (
    <div className="space-y-5" data-testid="members-tab">
      {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}

      {/* E-sign master switch + rollout scope */}
      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">{t("esignTitle")}</h2>
        {!env ? (
          <p className="text-sm text-stone-400">{t("loading")}</p>
        ) : !bootstrapped ? (
          <p className="rounded-lg bg-stone-50 p-3 text-sm text-stone-500">{t("esignNotSetUpAdmin")}</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{enabled ? t("esignOn") : t("esignOff")}</p>
                <p className="text-xs text-stone-500">{enabled ? t("esignOnBody") : t("esignOffBody")}</p>
              </div>
              <button
                className={enabled ? "btn-soft-danger" : "btn-primary"}
                data-testid="esign-toggle"
                onClick={async () => {
                  try {
                    await patchRegistry({ enabled: !enabled });
                  } catch (err) {
                    setError(thrown(err, t("saveFailed")));
                  }
                }}
              >
                {enabled ? t("turnOff") : t("turnOn")}
              </button>
            </div>
            {enabled && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm font-medium">{t("scopeLabel")}</span>
                <div
                  className="inline-flex items-center gap-0.5 rounded-lg bg-stone-100 p-0.5"
                  role="group"
                  aria-label={t("scopeLabel")}
                  data-testid="scope-switch"
                >
                  {(["allowlist", "everyone"] as const).map((value) => {
                    const active = scope === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={active}
                        data-testid={`scope-${value}`}
                        className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                          active
                            ? "bg-white text-indigo-700 shadow-sm"
                            : "text-stone-500 hover:text-stone-800"
                        }`}
                        onClick={async () => {
                          if (active) return;
                          try {
                            await patchRegistry({ scope: value });
                          } catch (err) {
                            setError(thrown(err, t("saveFailed")));
                          }
                        }}
                      >
                        {value === "allowlist" ? t("scopeAllowlist") : t("scopeEveryone")}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* Verified-mirror member directory (read-only here — the management
          actions live on the Members page) */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-stone-500">{t("membersTitle")}</h2>
        <p className="text-xs text-stone-500">
          {t.rich("membersManageNote", {
            link: (chunks) => (
              <Link href="/members" className="text-indigo-600 underline" data-testid="admin-members-link">
                {chunks}
              </Link>
            ),
          })}
        </p>
        {!members ? (
          <p className="text-sm text-stone-400">{t("loading")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-left text-xs text-stone-400">
                  <th className="py-2 pr-2 font-medium">{t("colMember")}</th>
                  <th className="px-2 py-2 font-medium">{t("colRole")}</th>
                  <th className="px-2 py-2 font-medium">{t("colEnrollment")}</th>
                  <th className="px-2 py-2 text-right font-medium">{t("colClaims")}</th>
                  {bootstrapped && enabled && scope === "allowlist" && (
                    <th className="px-2 py-2 text-right font-medium">{t("colAccess")}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId} className="border-b border-stone-100" data-testid={`member-${m.userId}`}>
                    <td className="py-2 pr-2">
                      <div className="font-medium">{m.name}</div>
                      <div className="break-all text-xs text-stone-400">{m.email}</div>
                    </td>
                    <td className="px-2 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ROLE_STYLE[m.role] ?? ROLE_STYLE.member}`}>
                        {roleLabel(m.role)}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-xs text-stone-500">
                      {m.identityStatus === "attested"
                        ? t("enrollAttested")
                        : m.identityStatus === "pending"
                          ? t("enrollPending")
                          : m.identityStatus === "revoked"
                            ? t("enrollRevoked")
                            : t("enrollNone")}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-stone-500">{m.claims}</td>
                    {bootstrapped && enabled && scope === "allowlist" && (
                      <td className="px-2 py-2 text-right">
                        {m.role === "admin" ? (
                          <span className="text-[11px] text-stone-400">{t("alwaysOn")}</span>
                        ) : (
                          <button
                            className="rounded-lg border border-stone-200 px-2 py-0.5 text-xs hover:bg-stone-50"
                            disabled={busyId === m.userId}
                            onClick={() => toggleAllowed(m, !m.allowed)}
                            data-testid={`allow-${m.userId}`}
                          >
                            {/* Verb = what the click DOES; a state-word here
                                reads as a label, not a control. */}
                            {busyId === m.userId ? "…" : m.allowed ? t("blockAction") : t("allowAction")}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Cryptographic vouch-for chain */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-stone-500">{t("chainTitle")}</h2>
        <p className="text-xs text-stone-500">{t("chainIntro")}</p>
        {!env ? null : !bootstrapped || !enabled ? (
          <p className="rounded-lg bg-stone-50 p-3 text-sm text-stone-500">{t("chainNeedsEsign")}</p>
        ) : !env.rosterLedgerKey ? (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{t("chainNeedsEnroll")}</p>
        ) : (
          <VouchChain env={env} />
        )}
      </section>
    </div>
  );
}

function VouchChain({ env }: { env: EsignEnv }) {
  const t = useTranslations("Admin");
  const tRole = useTranslations("Common.role");
  const dateLabel = useDateLabel();
  const thrown = useThrownErrorMessage();
  const [roster, setRoster] = useState<RosterTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);

  const roleLabel = (r: string) => {
    const key = roleLabelKey(r);
    return key ? tRole(key) : r;
  };

  const load = useCallback(async () => {
    try {
      const { roster } = await loadRoster(env);
      setRoster(roster);
    } catch (err) {
      setError(thrown(err, t("chainLoadFailed")));
    }
  }, [env, t, thrown]);

  if (error) return <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>;

  return (
    <SigningGate env={env} onReady={() => void load()}>
      {!roster ? (
        <p className="text-sm text-stone-400">{t("chainLoading")}</p>
      ) : (
        <div className="space-y-3" data-testid="vouch-chain">
          <div className="card p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">{t("chainRoot")}</p>
            <p className="mt-0.5 text-sm font-medium">{roster.root.name}</p>
            <p className="break-all text-xs text-stone-400">{roster.root.email}</p>
          </div>

          <ul className="space-y-1.5">
            {roster.members
              .filter((m) => m.uid !== roster.root.uid)
              .map((m, i) => {
                const roles = roster.rolesAt(m.uid, m.attestedAtMs);
                const revoked = m.revokedAtMs !== undefined;
                return (
                  <li
                    key={`${m.publicKey}-${i}`}
                    className={`rounded-lg border p-2.5 text-sm ${revoked ? "border-stone-200 bg-stone-50 opacity-60" : "border-stone-200"}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <span className="font-medium">{m.name}</span>
                      <span className="text-xs text-stone-400">
                        {revoked ? t("chainRevoked") : t("chainAttestedOn", { date: dateLabel(m.attestedAtMs) })}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {roles.length === 0 ? (
                        <span className="text-xs text-stone-400">{roleLabel("member")}</span>
                      ) : (
                        roles.map((r) => (
                          <span key={r} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ROLE_STYLE[r] ?? ROLE_STYLE.member}`}>
                            {roleLabel(r)}
                          </span>
                        ))
                      )}
                    </div>
                  </li>
                );
              })}
          </ul>

          {roster.pending.size > 0 && (
            <div>
              <p className="text-xs font-semibold text-stone-500">{t("chainPendingTitle")}</p>
              <ul className="mt-1 space-y-1">
                {[...roster.pending.values()].map((p, i) => (
                  <li key={i} className="rounded-lg border border-dashed border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                    {t("chainPending", { name: p.subject.name, vouches: p.voucherUids.size })}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {roster.anomalies.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-red-700">{t("chainAnomaliesTitle", { count: roster.anomalies.length })}</p>
              <ul className="mt-1 list-inside list-disc text-xs text-red-700">
                {roster.anomalies.map((a, i) => (
                  <li key={i}>
                    {(a.event.action as { t?: string }).t}: {a.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </SigningGate>
  );
}
