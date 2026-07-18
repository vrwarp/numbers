"use client";

/**
 * Role/key controls for one attested member (rendered on the Members page),
 * split along the two axes they live on: their ROLE (a select over the
 * grantable roles) and their SIGNING KEY (a separate, quieter destructive
 * action). Both changes route through a ConfirmDialog that spells out what
 * will happen — the select never commits on its own. Role grants are signed
 * roster events valid from the root or an executive officer/admin (A11);
 * key revocations stay root-only (docs/ESIGN_DESIGN.md §4.3, §4.5). Either
 * way the browser needs a connected signing session; the caller gates on the
 * viewer's mirror role.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { grantRole, revokeMemberKey, type EsignEnv } from "@/lib/esign/client";
import { useThrownErrorMessage } from "@/lib/use-api-error";
import ConfirmDialog from "./ConfirmDialog";

/** The role select's options: member (= no granted role) plus every grantable
 *  role. Admin is root-anchored and never offered from here. */
const GRANTABLE_ROLES = ["member", "approver", "secretary", "chairman", "treasurer"] as const;

export default function RoleControls({
  env,
  member,
  onDone,
}: {
  env: EsignEnv;
  member: { userId: string; name: string; role: string; publicKey: string };
  onDone: () => Promise<void>;
}) {
  const t = useTranslations("Members");
  const tRole = useTranslations("Common.role");
  const thrown = useThrownErrorMessage();
  type Role = (typeof GRANTABLE_ROLES)[number];
  const currentRole: Role = (GRANTABLE_ROLES as readonly string[]).includes(member.role)
    ? (member.role as Role)
    : "member";
  const [selectValue, setSelectValue] = useState<Role>(currentRole);
  // Key revocation is a root-only ledger action (§4.5) — an officer's REVOKE_KEY
  // would be rejected by the reducer, so don't offer the button off-root.
  const isRoot = !!env.rootPublicKey && env.me.publicKey === env.rootPublicKey;
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
        : r === "secretary"
          ? "roleExplainSecretary"
          : r === "chairman"
            ? "roleExplainChairman"
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

  // Role change is one or two signed roster events (§4.3): switching between
  // two roles revokes the old before granting the new; to/from member is a
  // single revoke or grant.
  async function applyRole() {
    setBusy(true);
    setError(null);
    try {
      if (currentRole !== "member") await grantRole(env, member.userId, currentRole, true);
      if (selectValue !== "member") await grantRole(env, member.userId, selectValue, false);
      setDialog(null);
      await onDone();
    } catch (err) {
      setError(thrown(err, t("actionFailed")));
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
      setError(thrown(err, t("actionFailed")));
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
          {GRANTABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {tRole(r)}
            </option>
          ))}
        </select>
      </label>
      {isRoot && (
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
      )}

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
