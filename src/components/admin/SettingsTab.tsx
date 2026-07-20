"use client";

/**
 * Deployment settings editor (docs/ADMIN.md "Guard-rails"): a grouped, plain-
 * language form over the allowlisted config.json keys — never a raw-JSON blob.
 * Secrets are write-only (a "set" badge + "leave blank to keep"); numbers/enums
 * validate before the file is written. Only changed fields are sent.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useThrownErrorMessage } from "@/lib/use-api-error";
import { ADMIN_CONFIG_GROUPS } from "@/lib/admin/config-schema";
import NotificationsHealthCard from "./NotificationsHealthCard";
import { FieldRow, type Field } from "./FieldRow";

export default function SettingsTab() {
  const t = useTranslations("Admin");
  const tx = t as unknown as (k: string) => string;
  const thrown = useThrownErrorMessage();
  const [fields, setFields] = useState<Field[] | null>(null);
  const [filePath, setFilePath] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/config");
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
      const data = (await res.json()) as { filePath: string; fields: Field[] };
      setFields(data.fields);
      setFilePath(data.filePath);
      setDraft(Object.fromEntries(data.fields.map((f) => [f.key, f.value])));
      setCleared(new Set());
      setOk(false);
    } catch (err) {
      setError(thrown(err, t("loadFailed")));
    }
  }, [t, thrown]);

  useEffect(() => {
    void load();
  }, [load]);

  // Diff against the loaded state: only genuine edits are sent.
  const { values, clear } = useMemo(() => {
    const values: Record<string, string> = {};
    const clear: string[] = [];
    for (const f of fields ?? []) {
      const current = draft[f.key] ?? "";
      if (cleared.has(f.key)) {
        clear.push(f.key);
      } else if (f.secret) {
        if (current.trim() !== "") values[f.key] = current; // set/replace
      } else if (current !== f.value) {
        values[f.key] = current; // "" clears, per normalizeConfigValue
      }
    }
    return { values, clear };
  }, [fields, draft, cleared]);

  const pending = Object.keys(values).length + clear.length;

  async function save() {
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      const res = await fetch("/api/admin/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values, clear }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
      setOk(true);
      await load();
    } catch (err) {
      setError(thrown(err, t("saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  if (!fields && !error) return <p className="text-sm text-stone-400">{t("loading")}</p>;

  return (
    <div className="space-y-4" data-testid="settings-tab">
      <p className="text-sm text-stone-600">{t("settingsIntro")}</p>
      <p className="break-all text-xs text-stone-400">{t("fileAt", { path: filePath })}</p>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {ok && (
        <p className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-800" data-testid="settings-saved">
          {t("settingsSaved")}
        </p>
      )}

      {ADMIN_CONFIG_GROUPS.map((group) => {
        const groupFields = (fields ?? []).filter((f) => f.group === group);
        if (groupFields.length === 0) return null;
        return (
          <div key={group} className="card space-y-3 p-4">
            <h2 className="font-semibold">{tx(`group_${group}`)}</h2>
            {groupFields.map((f) => (
              <FieldRow
                key={f.key}
                field={f}
                value={draft[f.key] ?? ""}
                cleared={cleared.has(f.key)}
                onChange={(v) => {
                  setDraft((d) => ({ ...d, [f.key]: v }));
                  setCleared((c) => {
                    if (!c.has(f.key)) return c;
                    const next = new Set(c);
                    next.delete(f.key);
                    return next;
                  });
                }}
                onClear={() =>
                  setCleared((c) => {
                    const next = new Set(c);
                    next.add(f.key);
                    return next;
                  })
                }
              />
            ))}
          </div>
        );
      })}

      <NotificationsHealthCard />

      <div className="sticky bottom-0 flex items-center gap-3 border-t border-stone-200 bg-white/90 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur">
        <button className="btn-primary" disabled={busy || pending === 0} onClick={save} data-testid="settings-save">
          {busy ? t("saving") : t("saveChanges", { count: pending })}
        </button>
        {pending > 0 && (
          <button className="btn-secondary" onClick={() => void load()} disabled={busy}>
            {t("discard")}
          </button>
        )}
      </div>
    </div>
  );
}
