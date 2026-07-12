"use client";

/**
 * Voucher's side of the in-person ceremony (docs/ESIGN_DESIGN.md §4.3).
 * The QR scan is the binding channel — either a `/vouch?c=` URL the voucher
 * opened (their phone's camera app followed the link) or, better on
 * multi-browser devices, an in-page scan (VouchQrScanner) that reads the
 * candidate's QR right here in the browser already holding the voucher's key
 * and session. The pending-list fallback carries no binding, so it requires
 * the candidate's FULL 64-hex key fingerprint — never the 6-digit spoken
 * code, which is grindable. The voucher's one job is confirming the human in
 * front of them matches the identity on screen.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useTranslations } from "next-intl";
import {
  backendNeedsPopup,
  grantRole,
  loadEnv,
  loadRoster,
  revokeMemberKey,
  vouchFor,
  type EsignEnv,
  type VouchSubject,
} from "@/lib/esign/client";
import { fingerprintDisplay, keyFingerprint } from "@/lib/esign/canonical";
import { decodeSubject } from "@/lib/esign/vouch-scan";
import { useThrownErrorMessage } from "@/lib/use-api-error";
import VouchQrScanner from "./VouchQrScanner";
import { SigningConnectCard, useSigningSession } from "./SigningConnect";

/** Bottom-sheet-on-mobile / centered-on-desktop confirm modal (matches the
 *  submit ceremony's chrome), used for both role changes and key revocation. */
function ConfirmDialog({
  title,
  confirmLabel,
  danger = false,
  busy = false,
  error,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const tCommon = useTranslations("Common");
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[92vh] w-full max-w-md space-y-4 overflow-y-auto rounded-t-2xl bg-white p-6 sm:rounded-2xl">
        <h3 className="text-lg font-bold">{title}</h3>
        <div className="space-y-2 text-sm text-stone-600">{children}</div>
        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            {tCommon("cancel")}
          </button>
          <button
            className={danger ? "btn-danger" : "btn-primary"}
            onClick={onConfirm}
            disabled={busy}
            data-testid="confirm-dialog-submit"
          >
            {busy ? "…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Admin controls for one attested member, split along the two axes they live
 * on: their ROLE (a select — one of member/approver/treasurer) and their
 * SIGNING KEY (a separate, quieter destructive action). Both changes route
 * through a ConfirmDialog that spells out what will happen — the select never
 * commits on its own, and the key revocation replaces the old confirm().
 */
function RoleControls({
  env,
  member,
  onDone,
}: {
  env: EsignEnv;
  member: { userId: string; name: string; role: string; publicKey: string };
  onDone: () => Promise<void>;
}) {
  const t = useTranslations("Vouch");
  const tRole = useTranslations("Common.role");
  const thrown = useThrownErrorMessage();
  type Role = "member" | "approver" | "treasurer";
  const currentRole: Role =
    member.role === "approver" || member.role === "treasurer" ? member.role : "member";
  const [selectValue, setSelectValue] = useState<Role>(currentRole);
  const [dialog, setDialog] = useState<null | "role" | "key">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync the select when a roster refresh moves the mirror role under us.
  useEffect(() => {
    setSelectValue(currentRole);
  }, [currentRole]);

  const roleBlurb = (r: Role) =>
    t(
      r === "approver"
        ? "roleExplainApprover"
        : r === "treasurer"
          ? "roleExplainTreasurer"
          : "roleExplainMember"
    );

  function pickRole(next: Role) {
    if (next === currentRole) return;
    setSelectValue(next);
    setError(null);
    setDialog("role");
  }
  function cancelRole() {
    setSelectValue(currentRole);
    setError(null);
    setDialog(null);
  }

  // Role change is one or two root-signed roster events (§4.3): switching
  // between two roles revokes the old before granting the new; to/from member
  // is a single revoke or grant.
  async function applyRole() {
    setBusy(true);
    setError(null);
    try {
      if (currentRole !== "member") await grantRole(env, member.userId, currentRole, true);
      if (selectValue !== "member") await grantRole(env, member.userId, selectValue, false);
      setDialog(null);
      await onDone();
    } catch (err) {
      setError(thrown(err, t("vouchFailed")));
    } finally {
      setBusy(false);
    }
  }

  // §4.5 compromised-device path: the member reports the loss in person and the
  // root retires the KEY itself. Their history stays valid; they enroll a fresh
  // key and get re-vouched.
  async function applyRevokeKey() {
    setBusy(true);
    setError(null);
    try {
      await revokeMemberKey(env, member.publicKey);
      setDialog(null);
      await onDone();
    } catch (err) {
      setError(thrown(err, t("vouchFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5 sm:items-end">
      <label className="flex items-center gap-2">
        <span className="text-xs font-medium text-stone-500">{t("roleLabel")}</span>
        <select
          className="min-h-[42px] rounded-lg border border-stone-300 bg-white py-2 pl-3 pr-8 text-sm text-stone-800 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
          value={selectValue}
          disabled={busy}
          onChange={(e) => pickRole(e.target.value as Role)}
          data-testid={`role-select-${member.userId}`}
        >
          <option value="member">{tRole("member")}</option>
          <option value="approver">{tRole("approver")}</option>
          <option value="treasurer">{tRole("treasurer")}</option>
        </select>
      </label>
      <div className="w-full border-t border-dashed border-stone-200 pt-1.5 sm:flex sm:justify-end">
        <button
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          disabled={busy}
          onClick={() => {
            setError(null);
            setDialog("key");
          }}
          data-testid={`revoke-key-${member.userId}`}
        >
          <span aria-hidden>🔑</span>
          {t("revokeKey")}
        </button>
      </div>

      {dialog === "role" && (
        <ConfirmDialog
          title={t("roleDialogTitle", { name: member.name })}
          confirmLabel={t("roleDialogConfirm")}
          busy={busy}
          error={error}
          onConfirm={applyRole}
          onCancel={cancelRole}
        >
          <p>
            {t.rich("roleDialogFromTo", {
              from: tRole(currentRole),
              to: tRole(selectValue),
              b: (chunks) => <strong className="font-semibold text-stone-800">{chunks}</strong>,
            })}
          </p>
          <p className="text-stone-500">{roleBlurb(selectValue)}</p>
        </ConfirmDialog>
      )}
      {dialog === "key" && (
        <ConfirmDialog
          title={t("keyDialogTitle", { name: member.name })}
          confirmLabel={t("revokeKey")}
          danger
          busy={busy}
          error={error}
          onConfirm={applyRevokeKey}
          onCancel={() => {
            setError(null);
            setDialog(null);
          }}
        >
          <p>{t("keyDialogBody")}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function VouchInner() {
  const t = useTranslations("Vouch");
  const tEsign = useTranslations("Esign");
  const tCommon = useTranslations("Common");
  const tRole = useTranslations("Common.role");
  const thrown = useThrownErrorMessage();
  const params = useSearchParams();
  const [env, setEnv] = useState<EsignEnv | null>(null);
  const [subject, setSubject] = useState<VouchSubject | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [manualFp, setManualFp] = useState("");
  const [members, setMembers] = useState<
    {
      userId: string;
      name: string;
      email: string;
      role: string;
      publicKey: string;
      fingerprint: string | null;
    }[]
  >([]);
  const [pending, setPending] = useState<VouchSubject[]>([]);
  // Active roster keys per uid — the source of truth for spotting a RE-KEY
  // vouch (the mirror's members list can't see it: a re-enrolling member's
  // row is already pending on their NEW key while the roster still attests
  // the old one).
  const [activeKeys, setActiveKeys] = useState<Record<string, string[]>>({});
  const [confirmed, setConfirmed] = useState(false);
  // True once the subject arrived over a binding channel — the QR in the URL
  // (`c`) or an in-page camera scan — as opposed to being hand-picked from the
  // pending list, which still demands the full fingerprint (§4.3).
  const [scannedBinding, setScannedBinding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const encoded = params.get("c");

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await loadEnv();
        setEnv(loaded);
        if (encoded) {
          const s = decodeSubject(encoded);
          if (!s) setError(t("malformedLink"));
          else {
            setSubject(s);
            setFingerprint(await keyFingerprint(s.publicKey));
          }
        } else {
          // Manual path: list enrollment candidates awaiting vouches.
          const res = await fetch("/api/esign/pending");
          if (res.ok) setPending(((await res.json()).pending ?? []) as VouchSubject[]);
        }
        const membersRes = await fetch("/api/esign/members");
        if (membersRes.ok) setMembers((await membersRes.json()).members ?? []);
      } catch (err) {
        setError(thrown(err, tEsign("loadFailed")));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encoded]);

  const { phase, connect, connecting, error: connectError } = useSigningSession(env);

  // Active roster keys read the ledger backend (a Google popup on prod), so
  // only load them once this device has a signing session (below the connect
  // gate) — never on mount, where a fresh Safari load would pop.
  useEffect(() => {
    if (phase !== "ready" || !env) return;
    if (!(env.enabled && env.me.identityStatus && env.rosterLedgerKey)) return;
    void (async () => {
      try {
        const { roster } = await loadRoster(env);
        const byUid: Record<string, string[]> = {};
        for (const m of roster.members) {
          if (m.revokedAtMs === undefined) (byUid[m.uid] ??= []).push(m.publicKey);
        }
        setActiveKeys(byUid);
      } catch {
        // A missing roster read just hides the re-key notice; not fatal here.
      }
    })();
  }, [phase, env]);

  const canVouch =
    env?.enabled === true && env.allowed !== false && env.me.identityStatus === "attested";
  const mustConnect = !!env && backendNeedsPopup(env) && phase !== "ready";
  // URL `c` and camera scan are both binding channels; a pending-list pick is not.
  const strongBinding = Boolean(encoded) || scannedBinding;
  const manualMatches = useMemo(() => {
    const typed = manualFp.toLowerCase().replace(/[^0-9a-f]/g, "");
    return typed.length >= 32 && fingerprint?.startsWith(typed);
  }, [manualFp, fingerprint]);

  async function refreshMembers() {
    const res = await fetch("/api/esign/members");
    if (res.ok) setMembers((await res.json()).members ?? []);
  }

  async function handleScanned(s: VouchSubject) {
    setSubject(s);
    setScannedBinding(true);
    setFingerprint(await keyFingerprint(s.publicKey));
  }

  async function submitVouch() {
    if (!env || !subject) return;
    setBusy(true);
    setError(null);
    try {
      await vouchFor(env, subject);
      setDone(true);
      // The vouch may have just attested them — show the fresh roster state
      // (and, for the root, the role buttons for the new member).
      await refreshMembers();
    } catch (err) {
      setError(thrown(err, t("vouchFailed")));
    } finally {
      setBusy(false);
    }
  }

  if (!env) return <p className="text-sm text-stone-500">{tCommon("loading")}</p>;

  const roleName = (role: string) =>
    (["member", "approver", "treasurer", "admin"] as const).find((r) => r === role);

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {!canVouch ? (
        <p className="card p-5 text-sm text-stone-600">
          {t.rich("onlyAttested", {
            link: (chunks) => (
              <Link href="/profile" className="text-indigo-600 underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      ) : mustConnect ? (
        // Connect the signing session before any vouch / role action, so the
        // Google popup opens from this click (iOS/Safari popup rule).
        <div className="card p-5">
          <SigningConnectCard connect={connect} connecting={connecting} error={connectError} />
        </div>
      ) : done ? (
        <div className="card space-y-2 p-5" data-testid="vouch-done">
          <div className="text-3xl">✅</div>
          <p className="font-medium">{t("doneTitle", { name: subject?.name ?? "" })}</p>
          <p className="text-sm text-stone-500">{t("doneBody")}</p>
        </div>
      ) : subject ? (
        <div className="card space-y-4 p-5">
          <div>
            <div className="text-lg font-semibold" data-testid="vouch-subject-name">{subject.name}</div>
            <div className="text-sm text-stone-500">{subject.email}</div>
            {fingerprint && (
              <details className="mt-1 text-xs text-stone-500">
                <summary className="cursor-pointer select-none">{tEsign("auditDetails")}</summary>
                <code className="mt-1 block font-mono">{fingerprintDisplay(fingerprint)}</code>
              </details>
            )}
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-semibold">{t("beforeTitle")}</p>
            <ul className="mt-1 list-inside list-disc space-y-1">
              <li>{t("bullet1")}</li>
              <li>{t("bullet2")}</li>
              <li>{t("bullet3")}</li>
            </ul>
          </div>
          {(activeKeys[subject.uid] ?? []).some((k) => k !== subject.publicKey) && (
            <div
              className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900"
              data-testid="rekey-notice"
            >
              <p className="font-semibold">{t("rekeyTitle", { name: subject.name })}</p>
              <p className="mt-1">{t("rekeyBody")}</p>
            </div>
          )}
          {!strongBinding && (
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("manualLabel")}</label>
              <input
                className="input font-mono text-xs"
                placeholder={t("manualPlaceholder")}
                value={manualFp}
                onChange={(e) => setManualFp(e.target.value)}
                data-testid="manual-fingerprint"
              />
              {!manualMatches && manualFp.length > 0 && (
                <p className="text-xs text-red-600">{t("fpMismatch")}</p>
              )}
            </div>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              data-testid="vouch-confirm"
            />
            <span>
              {t.rich("confirmLabel", {
                name: subject.name,
                b: (chunks) => <strong>{chunks}</strong>,
              })}
            </span>
          </label>
          <button
            className="btn-primary w-full disabled:opacity-50"
            disabled={!confirmed || busy || (!strongBinding && !manualMatches)}
            onClick={submitVouch}
            data-testid="vouch-submit"
          >
            {busy ? tEsign("signing") : t("signVouch")}
          </button>
        </div>
      ) : (
        <div className="card space-y-4 p-5">
          <p className="text-sm text-stone-600">
            {t.rich("scanIntro", { b: (chunks) => <strong>{chunks}</strong> })}
          </p>
          <VouchQrScanner onScan={handleScanned} />
          <div className="space-y-2 border-t border-stone-100 pt-3">
            <p className="text-sm font-medium text-stone-500">{t("orPick")}</p>
            {pending.length === 0 ? (
              <p className="text-sm text-stone-500">{t("nobodyPending")}</p>
            ) : (
              <ul className="space-y-2">
                {pending.map((p) => (
                  <li key={p.uid}>
                    <button
                      className="btn-secondary w-full text-left"
                      onClick={async () => {
                        setSubject(p);
                        setFingerprint(await keyFingerprint(p.publicKey));
                      }}
                    >
                      {p.name} <span className="text-stone-400">({p.email})</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {members.length > 0 && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-stone-500">{t("attestedMembers")}</h2>
          <ul className="mt-1 divide-y divide-stone-100 text-sm">
            {members.map((m) => (
              <li
                key={m.userId}
                className="flex flex-col gap-3 py-4 first:pt-2 last:pb-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-stone-800">{m.name}</span>
                    {m.role !== "member" && (
                      <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                        {roleName(m.role) ? tRole(roleName(m.role)!) : m.role}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-stone-400">{m.email}</div>
                </div>
                {/* Role grants are root-signed roster events (§4.3) — only the
                    root's browser can produce them, and only once its signing
                    session is connected (they sign a roster event). */}
                {env.me.role === "admin" && phase === "ready" && m.userId !== env.me.userId && (
                  <RoleControls env={env} member={m} onDone={refreshMembers} />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function VouchScreen() {
  return (
    <Suspense fallback={<Fallback />}>
      <VouchInner />
    </Suspense>
  );
}

function Fallback() {
  const tCommon = useTranslations("Common");
  return <p className="text-sm text-stone-500">{tCommon("loading")}</p>;
}
