"use client";

/**
 * Admin-only rollout allowlist (docs/ESIGN_DESIGN.md A8): who can SEE and
 * USE electronic signing while the registry scope is "allowlist". This is an
 * app-surface gate for staged rollout — vouching still decides who can
 * actually sign, and removing someone never touches what they already signed.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useThrownErrorMessage } from "@/lib/use-api-error";

interface AllowlistUser {
  userId: string;
  email: string;
  name: string;
  role: string;
  allowed: boolean;
  identityStatus: string | null;
}

export default function AllowlistPanel() {
  const t = useTranslations("Identity");
  const thrown = useThrownErrorMessage();
  const [users, setUsers] = useState<AllowlistUser[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/esign/allowlist");
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
      setUsers(((await res.json()) as { users: AllowlistUser[] }).users);
    } catch (err) {
      setError(thrown(err, t("allowlistLoadFailed")));
    }
  }, [t, thrown]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setAllowed(user: AllowlistUser, allowed: boolean) {
    setBusyId(user.userId);
    setError(null);
    try {
      const res = await fetch("/api/esign/allowlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.userId, allowed }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
      setUsers((prev) =>
        prev ? prev.map((u) => (u.userId === user.userId ? { ...u, allowed } : u)) : prev
      );
    } catch (err) {
      setError(thrown(err, t("allowlistUpdateFailed")));
    } finally {
      setBusyId(null);
    }
  }

  if (users === null) {
    return <p className="text-sm text-stone-400">{t("allowlistLoading")}</p>;
  }

  return (
    <div className="rounded-xl border border-stone-200 bg-stone-50 p-3" data-testid="allowlist-panel">
      <p className="text-sm font-semibold">{t("allowlistTitle")}</p>
      <p className="mt-0.5 text-xs text-stone-500">{t("allowlistNote")}</p>
      {error && <p className="mt-2 rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <ul className="mt-2 space-y-2">
        {users.map((u) => (
          <li key={u.userId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="min-w-0">
              <span className="font-medium">{u.name}</span>{" "}
              <span className="break-all text-xs text-stone-400">({u.email})</span>
              {u.role === "admin" ? (
                <span className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                  {t("allowlistAlwaysOn")}
                </span>
              ) : u.allowed && u.identityStatus === "attested" ? (
                <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                  {t("chipReady")}
                </span>
              ) : null}
            </span>
            {u.role !== "admin" &&
              (u.allowed ? (
                <button
                  className="rounded-lg border border-stone-200 px-2 py-0.5 text-xs text-stone-500 hover:bg-stone-100"
                  disabled={busyId === u.userId}
                  onClick={() => setAllowed(u, false)}
                  data-testid={`disallow-${u.userId}`}
                >
                  {busyId === u.userId ? "…" : t("allowlistRemove")}
                </button>
              ) : (
                <button
                  className="rounded-lg border border-indigo-200 px-2 py-0.5 text-xs text-indigo-700 hover:bg-indigo-50"
                  disabled={busyId === u.userId}
                  onClick={() => setAllowed(u, true)}
                  data-testid={`allow-${u.userId}`}
                >
                  {busyId === u.userId ? "…" : t("allowlistAllow")}
                </button>
              ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
