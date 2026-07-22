"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/use-api-error";

/**
 * Firestore rules management (docs/ESIGN_DESIGN.md §9.2). Shows whether the
 * hardened rules are deployed (read via the SAVED read-only viewer key) and
 * offers a one-shot deploy using an EPHEMERAL admin key that is never stored.
 * Deliberately loud about credential hygiene — the deploy key can rewrite the
 * rules that keep the ledger tamper-evident.
 */

type Verdict =
  | { status: "mock" }
  | { status: "no-key" }
  | { status: "key-invalid" }
  | { status: "key-overprivileged" }
  | { status: "no-project" }
  | { status: "no-release" }
  | { status: "match" }
  | { status: "drift" }
  | { status: "error"; detail?: string };

type Health = {
  applicable: boolean;
  verdict: Verdict;
  viewerConfigured: boolean;
  viewerLabel: string | null;
};

const TONE: Record<Verdict["status"], "ok" | "warn" | "bad" | "info"> = {
  mock: "info",
  "no-key": "info",
  "key-invalid": "warn",
  "key-overprivileged": "bad",
  "no-project": "warn",
  "no-release": "bad",
  match: "ok",
  drift: "warn",
  error: "warn",
};

const TONE_CLASS: Record<"ok" | "warn" | "bad" | "info", string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warn: "border-amber-200 bg-amber-50 text-amber-800",
  bad: "border-red-200 bg-red-50 text-red-800",
  info: "border-stone-200 bg-stone-50 text-stone-600",
};

export default function RulesCard() {
  const t = useTranslations("Admin.rules");
  const apiError = useApiErrorMessage();
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [deployOpen, setDeployOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployed, setDeployed] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/esign/rules");
      setHealth(res.ok ? ((await res.json()) as Health) : null);
    } catch {
      setHealth(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function deploy() {
    setBusy(true);
    setDeployError(null);
    setDeployed(null);
    try {
      const res = await fetch("/api/esign/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceAccountJson: key }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: true; rulesetName: string; keyLabel: string }
        | ({ error?: string; code?: string; params?: { detail?: string } } | null);
      if (!res.ok || !body || !("ok" in body)) {
        const msg = apiError(body, t("deployFailed"));
        const detail = (body as { params?: { detail?: string } } | null)?.params?.detail;
        setDeployError(detail ? `${msg} (${detail})` : msg);
        return;
      }
      // Success — wipe the key from state immediately; it was never ours to keep.
      setKey("");
      setDeployOpen(false);
      setDeployed(t("deploySuccess", { ruleset: body.rulesetName.split("/").pop() ?? "ruleset" }));
      await refresh();
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : t("deployFailed"));
    } finally {
      setBusy(false);
    }
  }

  // Not a Firestore deployment (mock/emulator, or no Firebase project) —
  // nothing to manage.
  if (loading) return null;
  if (!health || !health.applicable || health.verdict.status === "mock") return null;

  const v = health.verdict;
  const statusKey =
    v.status === "match"
      ? "statusMatch"
      : v.status === "drift"
        ? "statusDrift"
        : v.status === "no-release"
          ? "statusNoRelease"
          : v.status === "no-project"
            ? "statusNoProject"
            : v.status === "no-key"
              ? "statusNoKey"
              : v.status === "key-invalid"
                ? "statusKeyInvalid"
                : v.status === "key-overprivileged"
                  ? "statusKeyOverprivileged"
                  : "statusError";

  return (
    <div className="card space-y-4 p-4" data-testid="rules-card">
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-2xl">
          🛡️
        </span>
        <div className="min-w-0">
          <h3 className="font-semibold">{t("title")}</h3>
          <p className="mt-0.5 text-sm text-stone-500">{t("intro")}</p>
        </div>
      </div>

      <div
        className={`rounded-lg border p-3 text-sm ${TONE_CLASS[TONE[v.status]]}`}
        data-testid="rules-status"
        data-status={v.status}
      >
        <p className="font-medium">
          {v.status === "error" ? t("statusError", { detail: v.detail ?? "unknown" }) : t(statusKey)}
        </p>
        {health.viewerConfigured && health.viewerLabel && (
          <p className="mt-1 text-xs opacity-80">{t("viewerLabel", { label: health.viewerLabel })}</p>
        )}
      </div>

      {deployed && (
        <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800" data-testid="rules-deployed">
          {deployed}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary" onClick={() => void refresh()} data-testid="rules-recheck">
          {t("recheck")}
        </button>
        <button
          className={v.status === "match" ? "btn-secondary" : "btn-primary"}
          onClick={() => setDeployOpen((o) => !o)}
          data-testid="rules-deploy-toggle"
        >
          {t("deployTitle")}
        </button>
      </div>

      {deployOpen && (
        <div className="space-y-3 rounded-xl border border-red-200 bg-red-50/60 p-3">
          <div className="rounded-lg border border-red-300 bg-white p-3 text-sm text-red-800">
            <p className="font-semibold">⚠︎ {t("deployWarnTitle")}</p>
            <p className="mt-1">{t("deployWarn")}</p>
          </div>
          <label className="block text-sm">
            <span className="font-medium">{t("deployField")}</span>
            <textarea
              className="input mt-1 h-28 w-full font-mono text-xs"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder='{"type":"service_account", …}'
              autoComplete="off"
              spellCheck={false}
              data-testid="rules-deploy-key"
            />
          </label>
          {deployError && (
            <p className="rounded-lg bg-red-100 p-2 text-sm text-red-800" data-testid="rules-deploy-error">
              {deployError}
            </p>
          )}
          <button
            className="btn-primary disabled:opacity-50"
            disabled={busy || !key.trim()}
            onClick={deploy}
            data-testid="rules-deploy-submit"
          >
            {busy ? t("deployBusy") : t("deployButton")}
          </button>
        </div>
      )}

      <details className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600">
        <summary className="cursor-pointer select-none font-medium text-stone-500">{t("howToTitle")}</summary>
        <div className="mt-2 space-y-2">
          <p>{t("howToViewer")}</p>
          <p>{t("howToAdmin")}</p>
          <p className="rounded bg-amber-50 p-2 text-amber-800">{t("storeSafely")}</p>
        </div>
      </details>
    </div>
  );
}
