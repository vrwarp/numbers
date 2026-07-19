"use client";

/**
 * The Members page (/members): the church's people-administration surface,
 * gated like Budget Categories and Positions (treasurer/admin). It gathers
 * what used to be fragmented across the app — the attested roster with the
 * root's role/key controls (previously the vouch screen), everyone's e-sign
 * enrollment state, and the rollout-allowlist grants (previously only the
 * admin dashboard and the profile card).
 *
 * Authority boundaries: role grants are signed roster events valid from the
 * root or an executive officer/admin (A11) — RoleControls renders for those
 * mirror roles once connected and un-paused (the ledger re-checks authority
 * regardless) — while the e-sign access buttons call the admin-only allowlist
 * PATCH, so only the admin sees them.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  backendNeedsPopup,
  loadEnv,
  type EsignEnv,
} from "@/lib/esign/client";
import { useThrownErrorMessage } from "@/lib/use-api-error";
import { ROLE_MANAGER_ROLES } from "@/lib/esign/types";
import { roleLabelKey } from "@/lib/role-label";
import { fingerprintDisplay } from "@/lib/esign/canonical";
import { useDateLabel } from "@/lib/use-date-label";
import { usePositionLabel } from "@/lib/use-position-label";
import type { PositionNameSet } from "@/lib/positions";
import RoleControls from "./esign/RoleControls";
import { SigningConnectCard, useSigningSession } from "./esign/SigningConnect";

interface DirectoryMember {
  userId: string;
  name: string;
  email: string;
  role: string;
  position: PositionNameSet | null;
  allowed: boolean;
  identityStatus: string | null;
  attestedAt: string | null;
  publicKey: string | null;
  fingerprint: string | null;
}

const ROLE_STYLE: Record<string, string> = {
  admin: "bg-indigo-100 text-indigo-700",
  treasurer: "bg-purple-100 text-purple-700",
  chairman: "bg-amber-100 text-amber-700",
  secretary: "bg-emerald-100 text-emerald-700",
  approver: "bg-sky-100 text-sky-700",
  member: "bg-stone-100 text-stone-500",
};

export default function MembersDirectory() {
  const t = useTranslations("Members");
  const tRole = useTranslations("Common.role");
  const positionLabel = usePositionLabel();
  const dateLabel = useDateLabel();
  const thrown = useThrownErrorMessage();
  const [members, setMembers] = useState<DirectoryMember[] | null>(null);
  const [env, setEnv] = useState<EsignEnv | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const roleLabel = (r: string) => {
    const key = roleLabelKey(r);
    return key ? tRole(key) : r;
  };

  const loadMembers = useCallback(async () => {
    const res = await fetch("/api/members");
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
    setMembers(((await res.json()) as { members: DirectoryMember[] }).members);
  }, []);

  useEffect(() => {
    void loadMembers().catch((err) => setError(thrown(err, t("loadFailed"))));
    // The e-sign env only decorates the directory (chips, admin controls) —
    // a load failure degrades to the plain people list, not an error.
    void loadEnv().then(setEnv).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { phase, connect, connecting, error: connectError } = useSigningSession(env);

  const esignOn = !!env?.bootstrapped && !!env.enabled;
  // Role/key controls sign roster events — shown to un-paused role managers
  // (executive officers + admin, A11) with a signing session on this device;
  // the ledger re-checks the signer's authority regardless. The allowlist
  // PATCH is admin-only server-side, so its buttons stay admin-only here.
  const isAdmin = env?.me.role === "admin" && !env.me.adminPaused;
  const isRoleManager =
    !!env && (ROLE_MANAGER_ROLES as readonly string[]).includes(env.me.role) && !env.me.adminPaused;
  const canManageRoles = isRoleManager && esignOn && phase === "ready";
  const adminMustConnect =
    isRoleManager && esignOn && !!env && backendNeedsPopup(env) && phase !== "ready";
  const allowlistActive = isAdmin && esignOn && env?.scope !== "everyone";

  async function setAllowed(m: DirectoryMember, allowed: boolean) {
    setBusyId(m.userId);
    setError(null);
    try {
      const res = await fetch("/api/esign/allowlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: m.userId, allowed }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
      setMembers((prev) =>
        prev?.map((u) => (u.userId === m.userId ? { ...u, allowed } : u)) ?? prev
      );
    } catch (err) {
      setError(thrown(err, t("saveFailed")));
    } finally {
      setBusyId(null);
    }
  }

  // Enrollment chip for the not-yet-attested rows (attested rows sit in their
  // own section, so "attested" needs no chip).
  const statusChip = (m: DirectoryMember) =>
    m.identityStatus === "pending" ? (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
        {t("statusPending")}
      </span>
    ) : m.identityStatus === "revoked" ? (
      <span
        className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-800"
        title={t("statusRevokedHint")}
      >
        {t("statusRevoked")}
      </span>
    ) : (
      <span
        className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-semibold text-stone-500"
        title={t("statusNoneHint")}
      >
        {t("statusNone")}
      </span>
    );

  const accessButton = (m: DirectoryMember) =>
    m.role === "admin" ? (
      <span className="text-[11px] text-stone-400">{t("accessAlwaysOn")}</span>
    ) : m.allowed ? (
      <button
        className="rounded-lg border border-stone-200 px-2.5 py-1 text-xs text-stone-500 hover:bg-stone-100"
        disabled={busyId === m.userId}
        onClick={() => setAllowed(m, false)}
        data-testid={`disallow-${m.userId}`}
      >
        {busyId === m.userId ? "…" : t("accessCancel")}
      </button>
    ) : (
      <button
        className="rounded-lg border border-indigo-200 px-2.5 py-1 text-xs text-indigo-700 hover:bg-indigo-50"
        disabled={busyId === m.userId}
        onClick={() => setAllowed(m, true)}
        data-testid={`allow-${m.userId}`}
      >
        {busyId === m.userId ? "…" : t("accessGrant")}
      </button>
    );

  function memberIdentity(m: DirectoryMember) {
    return (
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-stone-800">{m.name}</span>
          {m.role !== "member" && (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${ROLE_STYLE[m.role] ?? ROLE_STYLE.member}`}
            >
              {roleLabel(m.role)}
            </span>
          )}
          {m.position && (
            <span className="rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-xs text-stone-600">
              {positionLabel(m.position)}
            </span>
          )}
        </div>
        <div className="mt-0.5 break-all text-xs text-stone-400">{m.email}</div>
      </div>
    );
  }

  if (!members && !error) return <p className="text-sm text-stone-400">{t("loading")}</p>;

  const attested = (members ?? []).filter((m) => m.identityStatus === "attested");
  const others = (members ?? []).filter((m) => m.identityStatus !== "attested");

  return (
    <div className="space-y-4" data-testid="members-directory">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="mt-0.5 text-sm text-stone-500">{t("subtitle")}</p>
      </div>

      {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}

      {/* Sibling management surfaces — Positions and Budget Categories link
          back here the same way. */}
      <div className="flex flex-wrap items-center gap-2">
        <Link className="btn-secondary" href="/vouch" data-testid="members-vouch-link">
          {t("vouchLink")}
        </Link>
        <Link className="btn-secondary" href="/positions">
          {t("positionsLink")}
        </Link>
        <Link className="btn-secondary" href="/ministries">
          {t("categoriesLink")}
        </Link>
      </div>

      {env && !esignOn && (
        <p className="rounded-lg bg-stone-50 p-2.5 text-xs text-stone-600">{t("esignOffNote")}</p>
      )}

      {/* Role/key management signs roster events, so the admin's device needs
          its signing session first (Google popup on the real backend). */}
      {adminMustConnect && (
        <SigningConnectCard connect={connect} connecting={connecting} error={connectError} />
      )}

      {attested.length > 0 && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-stone-500">{t("attestedTitle")}</h2>
          <ul className="mt-3 space-y-3 text-sm">
            {attested.map((m) => (
              <li
                key={m.userId}
                className="flex flex-col gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                data-testid={`member-row-${m.userId}`}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  {memberIdentity(m)}
                  {/* The API computes these for every attested member — show
                      them: the fingerprint is what an admin verifies against a
                      member's Profile card, and "attested since" answers the
                      basic "is this person set up?" question positively. */}
                  <p className="text-[11px] text-stone-400">
                    {m.fingerprint && (
                      <code className="mr-2 font-mono" data-testid={`member-fp-${m.userId}`}>
                        {fingerprintDisplay(m.fingerprint)}
                      </code>
                    )}
                    {m.attestedAt && t("attestedSince", { date: dateLabel(m.attestedAt) })}
                  </p>
                  {allowlistActive && <div>{accessButton(m)}</div>}
                </div>
                {canManageRoles && env && m.userId !== env.me.userId && m.publicKey && (
                  <RoleControls
                    env={env}
                    member={{ userId: m.userId, name: m.name, role: m.role, publicKey: m.publicKey }}
                    onDone={loadMembers}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card p-5">
        <h2 className="text-sm font-semibold text-stone-500">{t("othersTitle")}</h2>
        {others.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500">{t("othersEmpty")}</p>
        ) : (
          <ul className="mt-3 space-y-3 text-sm">
            {others.map((m) => (
              <li
                key={m.userId}
                className="flex flex-col gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                data-testid={`member-row-${m.userId}`}
              >
                {memberIdentity(m)}
                <div className="flex flex-wrap items-center gap-2">
                  {esignOn && statusChip(m)}
                  {allowlistActive && accessButton(m)}
                </div>
              </li>
            ))}
          </ul>
        )}
        {esignOn && others.some((m) => m.identityStatus === "pending") && (
          <p className="mt-3 text-xs text-stone-500">
            {t.rich("pendingHint", {
              link: (chunks) => (
                <Link href="/vouch" className="text-indigo-600 underline">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        )}
      </div>
    </div>
  );
}
