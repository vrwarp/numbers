"use client";

/**
 * Teams editor (docs/agent/ARCHITECTURE.md): named member groups associated
 * with budget categories. Membership grants exactly one thing — the READ-ONLY
 * team visibility expansion (docs/SEARCH_DESIGN.md §6.3 team amendment): a
 * member may view/list/search the receipts (and containing claims) whose line
 * items carry one of the team's budget-category codes on a non-draft claim.
 * The banner states that boundary; nothing here touches roles or writes.
 *
 * Reads/writes /api/teams (Approver-or-above, audited). The budget-category
 * picker reads the ungated active catalog (code + name); associations are
 * stored as codes, so an archived category keeps matching its history (its
 * chip stays visible, labeled by raw code once it leaves the active list).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useThrownErrorMessage } from "@/lib/use-api-error";
import { roleLabelKey } from "@/lib/role-label";
import { parseMinistryCode, type MinistryEntry } from "@/lib/ministries";

interface MemberOption {
  userId: string;
  name: string;
  email: string;
  role: string;
}
interface ApiTeam {
  id: string;
  name: string;
  description: string;
  active: boolean;
  members: MemberOption[];
  codes: string[];
}
interface Row {
  key: string;
  id: string | null;
  name: string;
  description: string;
  active: boolean;
  memberIds: string[];
  codes: string[];
}

const ROLE_STYLE: Record<string, string> = {
  admin: "bg-indigo-100 text-indigo-700",
  treasurer: "bg-purple-100 text-purple-700",
  chairman: "bg-purple-100 text-purple-700",
  secretary: "bg-purple-100 text-purple-700",
  approver: "bg-sky-100 text-sky-700",
  member: "bg-stone-100 text-stone-500",
};

const serialize = (r: Row) => JSON.stringify([r.name, r.description, r.active, r.memberIds, r.codes]);

export default function Teams() {
  const t = useTranslations("Teams");
  const thrown = useThrownErrorMessage();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [catalog, setCatalog] = useState<MinistryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const snapshot = useRef<Map<string, string>>(new Map());
  const newKey = useRef(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/teams");
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
      const data = (await res.json()) as { teams: ApiTeam[]; members: MemberOption[] };
      const mapped: Row[] = data.teams.map((tm) => ({
        key: tm.id,
        id: tm.id,
        name: tm.name,
        description: tm.description,
        active: tm.active,
        memberIds: tm.members.map((m) => m.userId),
        codes: tm.codes,
      }));
      snapshot.current = new Map(mapped.map((r) => [r.key, serialize(r)]));
      setRows(mapped);
      setMembers(data.members);
      setOk(false);
    } catch (err) {
      setError(thrown(err, t("loadFailed")));
    }
  }, [t, thrown]);

  useEffect(() => {
    void load();
  }, [load]);

  // Active budget categories for the code picker — best-effort; on failure the
  // picker is empty but existing chips still render by raw code.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/ministries");
        if (res.ok) setCatalog((((await res.json()) as { entries: MinistryEntry[] }).entries) ?? []);
      } catch {
        /* leave catalog empty */
      }
    })();
  }, []);

  const memberById = useMemo(() => new Map(members.map((m) => [m.userId, m])), [members]);
  const nameByCode = useMemo(() => new Map(catalog.map((e) => [e.code, e.name])), [catalog]);

  const invalid = useMemo(() => {
    const bad = new Set<string>();
    for (const r of rows ?? []) if (!r.name.trim()) bad.add(r.key);
    return bad;
  }, [rows]);

  const changed = (rows ?? []).filter((r) => snapshot.current.get(r.key) !== serialize(r)).length;
  const canSave = changed > 0 && invalid.size === 0 && !busy;

  const patch = (key: string, next: Partial<Row>) => {
    setRows((rs) => (rs ?? []).map((r) => (r.key === key ? { ...r, ...next } : r)));
    setOk(false);
  };
  const addTeam = () => {
    const key = `add-${newKey.current++}`;
    setRows((rs) => [
      ...(rs ?? []),
      { key, id: null, name: "", description: "", active: true, memberIds: [], codes: [] },
    ]);
    setOk(false);
  };

  async function save() {
    if (!rows) return;
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      const res = await fetch("/api/teams", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teams: rows.map((r) => ({
            id: r.id ?? undefined,
            name: r.name,
            description: r.description,
            active: r.active,
            members: r.memberIds.map((userId) => ({ userId })),
            codes: r.codes,
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
    <div className="space-y-4" data-testid="teams-editor">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="mt-0.5 text-sm text-stone-500">{t("subtitle")}</p>
      </div>

      <p className="rounded-lg bg-stone-50 p-2.5 text-xs text-stone-600">ℹ {t("readOnlyNote")}</p>

      {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {ok && (
        <p className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-800" data-testid="teams-saved">
          {t("saved")}
        </p>
      )}

      <div className="flex justify-end">
        <button className="btn-primary" onClick={addTeam} data-testid="add-team">
          {t("addTeam")}
        </button>
      </div>

      {(rows ?? []).length === 0 && (
        <p className="rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-400">
          {t("empty")}
        </p>
      )}

      {(rows ?? []).map((r) => (
        <TeamCard
          key={r.key}
          row={r}
          bad={invalid.has(r.key)}
          members={members}
          memberById={memberById}
          catalog={catalog}
          nameByCode={nameByCode}
          onPatch={patch}
        />
      ))}

      <div className="sticky bottom-0 -mx-4 -mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-stone-200 bg-white/90 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur">
        <button className="btn-primary" disabled={!canSave} onClick={save} data-testid="teams-save">
          {busy ? t("saving") : changed > 0 ? t("save", { count: changed }) : t("saveNone")}
        </button>
        {changed > 0 && (
          <button className="btn-secondary" onClick={() => void load()} disabled={busy}>
            {t("discard")}
          </button>
        )}
      </div>
    </div>
  );
}

function TeamCard({
  row,
  bad,
  members,
  memberById,
  catalog,
  nameByCode,
  onPatch,
}: {
  row: Row;
  bad: boolean;
  members: MemberOption[];
  memberById: Map<string, MemberOption>;
  catalog: MinistryEntry[];
  nameByCode: Map<string, string>;
  onPatch: (key: string, next: Partial<Row>) => void;
}) {
  const t = useTranslations("Teams");
  const tRole = useTranslations("Common.role");
  const roleLabel = (r: string) => {
    const key = roleLabelKey(r);
    return key ? tRole(key) : r;
  };

  const availableMembers = members.filter((m) => !row.memberIds.includes(m.userId));
  const availableCodes = catalog.filter((e) => !row.codes.includes(e.code));
  const addMember = (userId: string) => {
    if (userId) onPatch(row.key, { memberIds: [...row.memberIds, userId] });
  };
  const removeMember = (userId: string) =>
    onPatch(row.key, { memberIds: row.memberIds.filter((id) => id !== userId) });
  const addCode = (value: string) => {
    // The picker submits a composed "<code> <name>" option value.
    const code = parseMinistryCode(value) ?? value;
    if (code && !row.codes.includes(code)) onPatch(row.key, { codes: [...row.codes, code].sort() });
  };
  const removeCode = (code: string) =>
    onPatch(row.key, { codes: row.codes.filter((c) => c !== code) });

  return (
    <div className={`card space-y-3 p-4 ${row.active ? "" : "opacity-70"}`} data-testid="team-card">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 space-y-2">
          <input
            className={`input font-semibold ${bad ? "border-red-400 ring-1 ring-red-300" : ""}`}
            value={row.name}
            placeholder={t("namePlaceholder")}
            aria-label={t("namePlaceholder")}
            onChange={(e) => onPatch(row.key, { name: e.target.value })}
            data-testid="team-name"
          />
          <input
            className="input text-sm text-stone-600"
            value={row.description}
            placeholder={t("descriptionPlaceholder")}
            aria-label={t("descriptionPlaceholder")}
            onChange={(e) => onPatch(row.key, { description: e.target.value })}
          />
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={row.active}
          onClick={() => onPatch(row.key, { active: !row.active })}
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
            row.active ? "bg-emerald-100 text-emerald-800" : "bg-stone-200 text-stone-600"
          }`}
          data-testid="team-active-toggle"
        >
          {row.active ? t("active") : t("archived")}
        </button>
      </div>

      {/* Budget categories: chips + picker. Stored as codes; a chip whose code
          left the active catalog renders the raw code so it's never hidden. */}
      <div className="border-t border-stone-100 pt-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          {t("ministries")}
        </p>
        {row.codes.length === 0 && <p className="mt-1 text-sm text-stone-400">{t("noMinistries")}</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          {row.codes.map((code) => (
            <span
              key={code}
              className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-600"
              data-testid="team-ministry-chip"
            >
              <span className="font-mono">{code}</span>
              {nameByCode.get(code) ?? ""}
              <button
                type="button"
                className="font-semibold text-stone-400 hover:text-red-600"
                onClick={() => removeCode(code)}
                aria-label={t("removeMinistryAria", { code })}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        {availableCodes.length > 0 && (
          <label className="mt-2 block text-xs font-medium text-stone-500">
            {t("addMinistry")}
            <select
              className="input mt-1 text-sm"
              value=""
              onChange={(e) => addCode(e.target.value)}
              data-testid="add-team-ministry"
            >
              <option value="">{t("chooseMinistry")}</option>
              {availableCodes.map((e) => (
                <option key={e.code} value={`${e.code} ${e.name}`}>
                  {e.code} {e.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="border-t border-stone-100 pt-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          {t("members")}
        </p>
        {row.memberIds.length === 0 && <p className="mt-1 text-sm text-stone-400">{t("noMembers")}</p>}
        <div className="mt-2 space-y-2">
          {row.memberIds.map((userId) => {
            const m = memberById.get(userId);
            return (
              <div key={userId} className="flex flex-wrap items-center gap-2" data-testid="team-member">
                <span className="text-sm font-semibold">{m?.name ?? userId}</span>
                {m && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ROLE_STYLE[m.role] ?? ROLE_STYLE.member}`}
                  >
                    {roleLabel(m.role)}
                  </span>
                )}
                <span className="flex-1" />
                <button
                  className="text-xs font-medium text-red-600 hover:underline"
                  onClick={() => removeMember(userId)}
                  data-testid="remove-team-member"
                >
                  {t("removeMember")}
                </button>
              </div>
            );
          })}
        </div>
        {availableMembers.length > 0 && (
          <label className="mt-3 block text-xs font-medium text-stone-500">
            {t("addMember")}
            <select
              className="input mt-1 text-sm"
              value=""
              onChange={(e) => addMember(e.target.value)}
              data-testid="add-team-member"
            >
              <option value="">{t("choosePerson")}</option>
              {availableMembers.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name} ({roleLabel(m.role)})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}
