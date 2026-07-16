"use client";

/**
 * Treasurer's budget-category editor (docs/agent/ARCHITECTURE.md). The
 * church-wide chart of accounts that fills the "Ministry / Fund" dropdown:
 * codes, names, descriptions, and archived state. Code + name are separate
 * first-class fields; a pick stores their composed "<code> <name>" — this
 * screen never rewrites what past claims already stored. Reads/writes
 * /api/ministries (editor-gated + audited); the list sorts itself by
 * (group, code) on save, so there is no manual reorder.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useThrownErrorMessage } from "@/lib/use-api-error";

interface ApiRow {
  id: string | null;
  code: string;
  name: string;
  group: string;
  description: string;
  active: boolean;
}
interface Row extends ApiRow {
  key: string; // stable client key (id, or a fresh id for a new row)
}

const serialize = (r: Row) => JSON.stringify([r.code, r.name, r.group, r.description, r.active]);

export default function BudgetCategories() {
  const t = useTranslations("Ministries");
  const thrown = useThrownErrorMessage();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const snapshot = useRef<Map<string, string>>(new Map());
  const newKey = useRef(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ministries?scope=all");
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
      const data = (await res.json()) as { rows: ApiRow[] };
      const mapped = data.rows.map((r, i) => ({ ...r, key: r.id ?? `new-${i}` }));
      snapshot.current = new Map(mapped.map((r) => [r.key, serialize(r)]));
      setRows(mapped);
      setOk(false);
    } catch (err) {
      setError(thrown(err, t("loadFailed")));
    }
  }, [t, thrown]);

  useEffect(() => {
    void load();
  }, [load]);

  const groupOrder = useMemo(() => {
    const seen: string[] = [];
    for (const r of rows ?? []) if (!seen.includes(r.group)) seen.push(r.group);
    return seen;
  }, [rows]);

  // Inline validation mirrors the server: 3-digit non-999 codes, non-empty
  // names, unique codes among active rows. `invalid` blocks save and rings the
  // offending fields.
  const invalid = useMemo(() => {
    const bad = new Set<string>();
    const activeByCode = new Map<string, string>();
    for (const r of rows ?? []) {
      const codeOk = /^\d{3}$/.test(r.code) && r.code !== "999";
      if (!codeOk || !r.name.trim()) bad.add(r.key);
      if (r.active && codeOk) {
        const prev = activeByCode.get(r.code);
        if (prev) {
          bad.add(r.key);
          bad.add(prev);
        } else activeByCode.set(r.code, r.key);
      }
    }
    return bad;
  }, [rows]);

  const changed = (rows ?? []).filter((r) => snapshot.current.get(r.key) !== serialize(r)).length;
  const canSave = changed > 0 && invalid.size === 0 && !busy;

  const patch = (key: string, next: Partial<ApiRow>) => {
    setRows((rs) => (rs ?? []).map((r) => (r.key === key ? { ...r, ...next } : r)));
    setOk(false);
  };
  const renameGroup = (from: string, to: string) => {
    setRows((rs) => (rs ?? []).map((r) => (r.group === from ? { ...r, group: to } : r)));
    setOk(false);
  };
  const addCategory = (group: string) => {
    const key = `add-${newKey.current++}`;
    setRows((rs) => [...(rs ?? []), { id: null, key, code: "", name: "", group, description: "", active: true }]);
    setOk(false);
  };
  const addGroup = () => {
    const base = t("newGroup");
    let name = base;
    let n = 2;
    while (groupOrder.includes(name)) name = `${base} ${n++}`;
    addCategory(name);
  };

  async function save() {
    if (!rows) return;
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      const res = await fetch("/api/ministries", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ministries: rows.map((r) => ({
            id: r.id ?? undefined,
            code: r.code,
            name: r.name,
            group: r.group,
            description: r.description,
            active: r.active,
          })),
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
      await load();
      setOk(true);
    } catch (err) {
      setError(thrown(err, t("saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  if (!rows && !error) return <p className="text-sm text-stone-400">{t("loading")}</p>;

  return (
    <div className="space-y-4" data-testid="budget-categories">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="mt-0.5 text-sm text-stone-500">{t("subtitle")}</p>
      </div>

      <p className="rounded-lg bg-amber-50 p-2.5 text-xs text-amber-900">⚠ {t("renameWarning")}</p>

      {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {ok && (
        <p className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-800" data-testid="ministries-saved">
          {t("saved")}
        </p>
      )}

      <div className="flex justify-end">
        <button className="btn-secondary" onClick={addGroup} data-testid="add-group">
          {t("addGroup")}
        </button>
      </div>

      {groupOrder.map((group) => (
        <GroupCard
          key={group}
          group={group}
          rows={(rows ?? []).filter((r) => r.group === group)}
          invalid={invalid}
          onRenameGroup={renameGroup}
          onPatch={patch}
          onAddCategory={addCategory}
        />
      ))}

      <div className="sticky bottom-0 -mx-4 -mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-stone-200 bg-white/90 px-4 py-3 backdrop-blur">
        <button className="btn-primary" disabled={!canSave} onClick={save} data-testid="ministries-save">
          {busy ? t("saving") : changed > 0 ? t("save", { count: changed }) : t("saveNone")}
        </button>
        {changed > 0 && (
          <button className="btn-secondary" onClick={() => void load()} disabled={busy}>
            {t("discard")}
          </button>
        )}
        <span className="ml-auto text-xs text-stone-400">{t("reservedNote")}</span>
      </div>
    </div>
  );
}

function GroupCard({
  group,
  rows,
  invalid,
  onRenameGroup,
  onPatch,
  onAddCategory,
}: {
  group: string;
  rows: Row[];
  invalid: Set<string>;
  onRenameGroup: (from: string, to: string) => void;
  onPatch: (key: string, next: Partial<ApiRow>) => void;
  onAddCategory: (group: string) => void;
}) {
  const t = useTranslations("Ministries");
  // Local state so typing the group name doesn't re-bucket rows on every
  // keystroke; the rename commits on blur.
  const [name, setName] = useState(group);
  useEffect(() => setName(group), [group]);
  const activeCount = rows.filter((r) => r.active).length;

  return (
    <div className="card space-y-1 p-4" data-testid="ministry-group">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs font-semibold"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== group && onRenameGroup(group, name.trim())}
          aria-label={t("groupNameAria")}
        />
        <span className="text-xs text-stone-400">{t("countActive", { active: activeCount, total: rows.length })}</span>
        <button
          className="btn-secondary ml-auto text-xs"
          onClick={() => onAddCategory(group)}
          data-testid="add-category"
        >
          {t("addCategory")}
        </button>
      </div>

      <div className="hidden gap-3 px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-stone-400 sm:grid sm:grid-cols-[4.5rem_12rem_1fr_auto]">
        <span>{t("code")}</span>
        <span>{t("name")}</span>
        <span>{t("description")}</span>
        <span>{t("active")}</span>
      </div>

      {rows.map((r) => {
        const bad = invalid.has(r.key);
        return (
          <div
            key={r.key}
            className={`grid grid-cols-[4.5rem_1fr_auto] items-center gap-2 border-t border-stone-100 py-2 sm:grid-cols-[4.5rem_12rem_1fr_auto] ${
              r.active ? "" : "opacity-60"
            }`}
            data-testid="ministry-row"
          >
            <input
              className={`input px-2 text-center font-mono ${bad ? "border-red-400 ring-1 ring-red-300" : ""}`}
              value={r.code}
              inputMode="numeric"
              maxLength={3}
              placeholder="000"
              aria-label={t("codeAria")}
              onChange={(e) => onPatch(r.key, { code: e.target.value.replace(/\D/g, "").slice(0, 3) })}
            />
            <input
              className={`input ${bad && !r.name.trim() ? "border-red-400 ring-1 ring-red-300" : ""} col-span-2 sm:col-span-1`}
              value={r.name}
              aria-label={t("nameAria")}
              onChange={(e) => onPatch(r.key, { name: e.target.value })}
            />
            <input
              className="input col-span-2 text-sm text-stone-600 sm:col-span-1"
              value={r.description}
              placeholder={t("descriptionPlaceholder")}
              aria-label={t("description")}
              onChange={(e) => onPatch(r.key, { description: e.target.value })}
            />
            <button
              type="button"
              role="switch"
              aria-checked={r.active}
              onClick={() => onPatch(r.key, { active: !r.active })}
              className={`justify-self-end rounded-full px-2.5 py-1 text-xs font-semibold ${
                r.active ? "bg-emerald-100 text-emerald-800" : "bg-stone-200 text-stone-600"
              }`}
              data-testid="ministry-active-toggle"
            >
              {r.active ? t("active") : t("archived")}
            </button>
          </div>
        );
      })}
    </div>
  );
}
