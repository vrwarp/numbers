"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations, useFormatter } from "next-intl";
import { useApiErrorMessage } from "@/lib/use-api-error";
import { MCP_SCOPES, type McpScope } from "@/lib/mcp/scopes";

/**
 * Profile → AI assistant connections (docs/MCP_DESIGN.md). The user's
 * access-control surface for the MCP backend: mint a personal access token,
 * choosing exactly which capabilities it carries, copy it once, and revoke it.
 * No token secret is ever re-shown — the API returns it only at creation.
 */

interface Connection {
  id: string;
  label: string;
  prefix: string;
  scopes: McpScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

const EXPIRY_CHOICES = [
  { days: 0, key: "expiryNever" },
  { days: 30, key: "expiry30" },
  { days: 90, key: "expiry90" },
  { days: 365, key: "expiry365" },
] as const;

export default function ConnectionsCard() {
  const t = useTranslations("Connections");
  const format = useFormatter();
  const apiError = useApiErrorMessage();

  // next-intl keys must be literals — map each scope to its translated label.
  const scopeLabel: Record<McpScope, string> = {
    "receipts:read": t("scope.receiptsRead"),
    "claims:read": t("scope.claimsRead"),
    "claims:draft": t("scope.claimsDraft"),
    "catalog:read": t("scope.catalogRead"),
    "catalog:draft": t("scope.catalogDraft"),
    "feedback:read": t("scope.feedbackRead"),
    "feedback:triage": t("scope.feedbackTriage"),
  };
  const scopeHint: Partial<Record<McpScope, string>> = {
    "catalog:read": t("scopeHint.catalogRead"),
    "catalog:draft": t("scopeHint.catalogDraft"),
    "feedback:read": t("scopeHint.feedbackRead"),
    "feedback:triage": t("scopeHint.feedbackRead"),
  };

  const [connections, setConnections] = useState<Connection[] | null>(null);
  // Which scopes this account may actually grant (server-computed). Until it
  // loads, offer only the always-available read/draft scopes so the list never
  // over-shows a capability the role lacks.
  const [availableScopes, setAvailableScopes] = useState<McpScope[]>(
    MCP_SCOPES.filter((s) => !s.startsWith("catalog:") && !s.startsWith("feedback:"))
  );
  const [error, setError] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  // New-connection form.
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<Set<McpScope>>(new Set(["receipts:read", "claims:read"]));
  const [expiryDays, setExpiryDays] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);

  useEffect(() => {
    setEndpoint(`${window.location.origin}/api/mcp`);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    const res = await fetch("/api/mcp-tokens").catch(() => null);
    if (res?.ok) {
      const { connections, availableScopes } = (await res.json()) as {
        connections: Connection[];
        availableScopes?: McpScope[];
      };
      setConnections(connections);
      if (availableScopes) {
        setAvailableScopes(availableScopes);
        // Drop any now-unavailable scope from a pending selection (e.g. a role
        // change since the form was opened) so we never submit one we'll refuse.
        const allowed = new Set(availableScopes);
        setScopes((prev) => new Set([...prev].filter((s) => allowed.has(s))));
      }
    } else {
      setError(t("loadFailed"));
    }
  }

  async function copy(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied((c) => (c === tag ? null : c)), 2500);
    } catch {
      // Clipboard unavailable — the value is on screen to select manually.
    }
  }

  function toggleScope(s: McpScope) {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  async function createConnection() {
    setBusy("create");
    setError(null);
    try {
      const res = await fetch("/api/mcp-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          scopes: [...scopes],
          ...(expiryDays ? { expiresInDays: expiryDays } : {}),
        }),
      });
      if (!res.ok) throw new Error(apiError(await res.json().catch(() => null), t("saveFailed")));
      const { token } = (await res.json()) as { token: string };
      setFreshToken(token);
      setLabel("");
      setScopes(new Set(["receipts:read", "claims:read"]));
      setExpiryDays(0);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(id: string) {
    setBusy(`revoke-${id}`);
    setError(null);
    try {
      const res = await fetch(`/api/mcp-tokens/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(apiError(await res.json().catch(() => null), t("saveFailed")));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium" });
  const canCreate = label.trim().length > 0 && scopes.size > 0 && busy !== "create";
  const showsCatalog = [...scopes].some((s) => s.startsWith("catalog:"));

  return (
    <section className="card p-5" aria-labelledby="connections-title" data-testid="connections-card">
      <h2 id="connections-title" className="text-lg font-bold">
        {t("title")}
      </h2>
      <p className="mt-1 text-sm text-stone-500">{t("subtitle")}</p>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      {/* Endpoint */}
      <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-3 text-sm">
        <p className="font-semibold">{t("endpointTitle")}</p>
        <p className="mt-1 text-stone-600">{t("endpointBody")}</p>
        <div className="mt-2 flex items-center gap-2">
          <code className="grow overflow-x-auto rounded bg-white px-2 py-1 text-xs">{endpoint}</code>
          <button type="button" className="btn-secondary shrink-0" onClick={() => void copy(endpoint, "endpoint")}>
            {copied === "endpoint" ? t("copied") : t("copy")}
          </button>
        </div>
      </div>

      {/* One-time token reveal */}
      {freshToken && (
        <div className="mt-4 rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm" data-testid="fresh-token">
          <p className="font-semibold">{t("tokenTitle")}</p>
          <p className="mt-1 text-stone-600">{t("tokenBody")}</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="grow overflow-x-auto rounded bg-white px-2 py-1 text-xs">{freshToken}</code>
            <button type="button" className="btn-primary shrink-0" onClick={() => void copy(freshToken, "token")}>
              {copied === "token" ? t("copied") : t("copy")}
            </button>
          </div>
          <button type="button" className="btn-secondary mt-2" onClick={() => setFreshToken(null)}>
            {t("done")}
          </button>
        </div>
      )}

      {/* New connection */}
      <div className="mt-4">
        <h3 className="text-sm font-bold">{t("newTitle")}</h3>
        <label className="mt-2 block text-sm">
          <span className="text-stone-600">{t("nameLabel")}</span>
          <input
            type="text"
            className="input mt-1 w-full"
            value={label}
            maxLength={100}
            placeholder={t("namePlaceholder")}
            onChange={(e) => setLabel(e.target.value)}
            data-testid="connection-name"
          />
        </label>

        <p className="mt-3 text-sm text-stone-600">{t("scopesLabel")}</p>
        <div className="mt-1 space-y-1">
          {MCP_SCOPES.filter((s) => availableScopes.includes(s)).map((s) => (
            <label key={s} className="flex items-start gap-2 rounded-lg border border-stone-200 p-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={scopes.has(s)}
                onChange={() => toggleScope(s)}
                data-testid={`scope-${s}`}
              />
              <span>
                <span className="font-medium">{scopeLabel[s]}</span>
                {scopeHint[s] && <span className="block text-xs text-stone-500">{scopeHint[s]}</span>}
              </span>
            </label>
          ))}
        </div>

        <label className="mt-3 block text-sm">
          <span className="text-stone-600">{t("expiryLabel")}</span>
          <select
            className="input mt-1 w-full"
            value={expiryDays}
            onChange={(e) => setExpiryDays(Number(e.target.value))}
            data-testid="connection-expiry"
          >
            {EXPIRY_CHOICES.map((c) => (
              <option key={c.days} value={c.days}>
                {t(c.key)}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="btn-primary mt-3"
          disabled={!canCreate}
          onClick={() => void createConnection()}
          data-testid="connection-create"
        >
          {busy === "create" ? t("creating") : t("create")}
        </button>
        {showsCatalog && (
          <p className="mt-2 text-xs">
            <Link className="text-indigo-700 underline" href="/catalog-drafts">
              {t("reviewLink")}
            </Link>
          </p>
        )}
      </div>

      {/* Existing connections */}
      <div className="mt-5 border-t border-stone-100 pt-4">
        <h3 className="text-sm font-bold">{t("existingTitle")}</h3>
        {connections && connections.length === 0 && (
          <p className="mt-2 text-sm text-stone-500">{t("empty")}</p>
        )}
        <ul className="mt-2 space-y-2">
          {connections?.map((c) => {
            const expired = c.expiresAt && new Date(c.expiresAt).getTime() <= Date.now();
            return (
              <li key={c.id} className="rounded-xl border border-stone-200 p-3 text-sm" data-testid="connection-row">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold">{c.label}</p>
                    <code className="text-xs text-stone-400">{c.prefix}…</code>
                  </div>
                  {c.revokedAt ? (
                    <span className="rounded bg-stone-100 px-2 py-0.5 text-xs font-semibold text-stone-500">
                      {t("revoked")}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn-danger shrink-0"
                      disabled={busy === `revoke-${c.id}`}
                      onClick={() => void revoke(c.id)}
                      data-testid="connection-revoke"
                    >
                      {busy === `revoke-${c.id}` ? t("revoking") : t("revoke")}
                    </button>
                  )}
                </div>
                <p className="mt-1 text-xs text-stone-500">
                  {t("can")} {c.scopes.map((s) => scopeLabel[s]).join(" · ")}
                </p>
                <p className="mt-1 text-xs text-stone-400">
                  {t("created", { date: date(c.createdAt) })}
                  {" · "}
                  {c.lastUsedAt ? t("lastUsed", { date: date(c.lastUsedAt) }) : t("neverUsed")}
                  {c.expiresAt && ` · ${expired ? t("expired") : t("expires", { date: date(c.expiresAt) })}`}
                </p>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
