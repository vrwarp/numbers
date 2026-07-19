"use client";

/**
 * Treasurer's Positions editor (docs/agent/ARCHITECTURE.md). Positions are
 * custom approval roles ("Deacon of Missions", "Office Staff") assigned to
 * people and used as the default approver for budget categories.
 *
 * A Position is a routing LABEL only — it grants no approval authority. So the
 * editor surfaces each holder's live eligibility and warns the moment a holder
 * who can't approve is assigned: they still need a signature-verified Approver+
 * grant before a claim can route to them. Reads/writes /api/positions
 * (editor-gated + audited); the "used by" category list comes from the
 * budget-category catalog so archiving a position in use is a visible decision.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useThrownErrorMessage } from "@/lib/use-api-error";
import { DEFAULT_POSITION_ENTRIES, builtinPositionKey, type ApproverEligibility } from "@/lib/positions";
import { roleLabelKey } from "@/lib/role-label";
import { usePositionLabel } from "@/lib/use-position-label";
import { composeMinistry } from "@/lib/ministries";
import ConfirmDialog from "@/components/ConfirmDialog";

interface Member {
  userId: string;
  name: string;
  email: string;
  role: string;
  eligibility: ApproverEligibility;
}
interface ApiHolder {
  userId: string;
  name: string;
  role: string;
  eligibility: ApproverEligibility;
  order: number;
}
interface ApiPosition {
  id: string;
  name: string;
  nameZhHans: string | null;
  nameZhHant: string | null;
  description: string;
  active: boolean;
  sortOrder: number;
  holders: ApiHolder[];
}
interface Row {
  key: string;
  id: string | null;
  name: string;
  nameZhHans: string; // custom position's Simplified name ("" = none)
  nameZhHant: string; // custom position's Traditional name ("" = none)
  description: string;
  active: boolean;
  holderIds: string[]; // primary first
}

const ROLE_STYLE: Record<string, string> = {
  admin: "bg-indigo-100 text-indigo-700",
  treasurer: "bg-purple-100 text-purple-700",
  chairman: "bg-amber-100 text-amber-700",
  secretary: "bg-emerald-100 text-emerald-700",
  approver: "bg-sky-100 text-sky-700",
  member: "bg-stone-100 text-stone-500",
};

const serialize = (r: Row) =>
  JSON.stringify([r.name, r.nameZhHans, r.nameZhHant, r.description, r.active, r.holderIds]);

export default function Positions() {
  const t = useTranslations("Positions");
  const thrown = useThrownErrorMessage();
  const positionLabel = usePositionLabel();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [usedBy, setUsedBy] = useState<Map<string, string[]>>(new Map());
  // Saved position ids the user removed, staged for hard-delete on Save (a new,
  // never-saved row is just dropped from `rows`, nothing to delete server-side).
  const [pendingDelete, setPendingDelete] = useState<Set<string>>(new Set());
  const [confirmRow, setConfirmRow] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const snapshot = useRef<Map<string, string>>(new Map());
  const newKey = useRef(0);

  const load = useCallback(async () => {
    try {
      const [posRes, minRes] = await Promise.all([
        fetch("/api/positions"),
        fetch("/api/ministries?scope=all"),
      ]);
      if (!posRes.ok) throw new Error((await posRes.json().catch(() => null))?.error);
      const data = (await posRes.json()) as { positions: ApiPosition[]; members: Member[] };
      const mapped: Row[] = data.positions.map((p) => ({
        key: p.id,
        id: p.id,
        name: p.name,
        nameZhHans: p.nameZhHans ?? "",
        nameZhHant: p.nameZhHant ?? "",
        description: p.description,
        active: p.active,
        holderIds: p.holders.map((h) => h.userId),
      }));
      snapshot.current = new Map(mapped.map((r) => [r.key, serialize(r)]));
      setRows(mapped);
      setMembers(data.members);
      setPendingDelete(new Set());
      setOk(false);
      // "Used by <categories>" — best-effort; a failure just hides the list.
      if (minRes.ok) {
        const min = (await minRes.json()) as {
          rows: { defaultPositionId: string | null; code: string; name: string }[];
        };
        const byPosition = new Map<string, string[]>();
        for (const m of min.rows) {
          if (!m.defaultPositionId) continue;
          const list = byPosition.get(m.defaultPositionId) ?? [];
          list.push(composeMinistry(m.code, m.name));
          byPosition.set(m.defaultPositionId, list);
        }
        setUsedBy(byPosition);
      }
    } catch (err) {
      setError(thrown(err, t("loadFailed")));
    }
  }, [t, thrown]);

  useEffect(() => {
    void load();
  }, [load]);

  const memberById = useMemo(() => new Map(members.map((m) => [m.userId, m])), [members]);

  const invalid = useMemo(() => {
    const bad = new Set<string>();
    for (const r of rows ?? []) if (!r.name.trim()) bad.add(r.key);
    return bad;
  }, [rows]);

  const edited = (rows ?? []).filter((r) => snapshot.current.get(r.key) !== serialize(r)).length;
  const changed = edited + pendingDelete.size;
  const canSave = changed > 0 && invalid.size === 0 && !busy;

  // A never-saved row just disappears; a saved one opens a confirm (it may be a
  // budget-category default) and, once confirmed, is staged for hard-delete.
  const requestDelete = (row: Row) => {
    if (!row.id) {
      setRows((rs) => (rs ?? []).filter((r) => r.key !== row.key));
      setOk(false);
      return;
    }
    setConfirmRow(row);
  };
  const confirmDelete = () => {
    const row = confirmRow;
    if (!row) return;
    setRows((rs) => (rs ?? []).filter((r) => r.key !== row.key));
    if (row.id) setPendingDelete((s) => new Set(s).add(row.id as string));
    setConfirmRow(null);
    setOk(false);
  };

  const patch = (key: string, next: Partial<Row>) => {
    setRows((rs) => (rs ?? []).map((r) => (r.key === key ? { ...r, ...next } : r)));
    setOk(false);
  };
  const addPosition = () => {
    const key = `add-${newKey.current++}`;
    setRows((rs) => [
      ...(rs ?? []),
      { key, id: null, name: "", nameZhHans: "", nameZhHant: "", description: "", active: true, holderIds: [] },
    ]);
    setOk(false);
  };
  // Seed the editor with the built-in deacon roster as unsaved rows (holders
  // unassigned) — offered from the empty state so a fresh catalog is one click
  // and a Save away, without the catalog ever materializing defaults on its own.
  const loadDefaults = () => {
    setRows((rs) => [
      ...(rs ?? []),
      ...DEFAULT_POSITION_ENTRIES.map((e) => ({
        key: `add-${newKey.current++}`,
        id: null,
        name: e.name,
        // Built-ins localize via the Positions.builtin catalog, not columns.
        nameZhHans: "",
        nameZhHant: "",
        description: e.description,
        active: e.active,
        holderIds: [],
      })),
    ]);
    setOk(false);
  };

  async function save() {
    if (!rows) return;
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      const res = await fetch("/api/positions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positions: rows.map((r) => ({
            id: r.id ?? undefined,
            name: r.name,
            nameZhHans: r.nameZhHans,
            nameZhHant: r.nameZhHant,
            description: r.description,
            active: r.active,
            holders: r.holderIds.map((userId) => ({ userId })),
          })),
          deleteIds: [...pendingDelete],
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
    <div className="space-y-4" data-testid="positions-editor">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="mt-0.5 text-sm text-stone-500">{t("subtitle")}</p>
      </div>

      <p className="rounded-lg bg-stone-50 p-2.5 text-xs text-stone-600">
        ℹ{" "}
        {t.rich("authorityNote", {
          link: (chunks) => (
            <Link href="/members" className="text-indigo-600 underline" data-testid="positions-members-link">
              {chunks}
            </Link>
          ),
        })}
      </p>

      {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {ok && (
        <p className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-800" data-testid="positions-saved">
          {t("saved")}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link className="btn-secondary" href="/ministries">
          {t("backToCategories")}
        </Link>
        <Link className="btn-secondary" href="/members">
          {t("membersPage")}
        </Link>
        <button className="btn-primary" onClick={addPosition} data-testid="add-position">
          {t("addPosition")}
        </button>
      </div>

      {(rows ?? []).length === 0 && (
        <div className="rounded-xl border border-dashed border-stone-300 p-6 text-center" data-testid="positions-empty">
          <p className="text-sm text-stone-400">{t("empty")}</p>
          <button
            className="btn-secondary mt-3"
            onClick={loadDefaults}
            data-testid="load-default-positions"
          >
            {t("loadDefaults")}
          </button>
          <p className="mt-2 text-xs text-stone-400">{t("loadDefaultsHint")}</p>
        </div>
      )}

      {(rows ?? []).map((r) => (
        <PositionCard
          key={r.key}
          row={r}
          bad={invalid.has(r.key)}
          members={members}
          memberById={memberById}
          usedByCategories={r.id ? usedBy.get(r.id) ?? [] : []}
          onPatch={patch}
          onDelete={requestDelete}
        />
      ))}

      <div className="sticky bottom-0 -mx-4 -mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-stone-200 bg-white/90 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur">
        <button className="btn-primary" disabled={!canSave} onClick={save} data-testid="positions-save">
          {busy ? t("saving") : changed > 0 ? t("save", { count: changed }) : t("saveNone")}
        </button>
        {changed > 0 && (
          <button className="btn-secondary" onClick={() => void load()} disabled={busy}>
            {t("discard")}
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmRow !== null}
        message={
          confirmRow
            ? [
                t("deleteConfirm", { name: positionLabel(confirmRow) }),
                (confirmRow.id ? usedBy.get(confirmRow.id)?.length ?? 0 : 0) > 0
                  ? t("deleteConfirmInUse", {
                      count: confirmRow.id ? usedBy.get(confirmRow.id)?.length ?? 0 : 0,
                    })
                  : "",
              ]
                .filter(Boolean)
                .join("\n\n")
            : ""
        }
        confirmLabel={t("delete")}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmRow(null)}
        testId="delete-position-dialog"
      />
    </div>
  );
}

function EligibilityBadge({ eligibility }: { eligibility: ApproverEligibility }) {
  const t = useTranslations("Positions");
  const map = {
    ok: "bg-emerald-100 text-emerald-800",
    paused: "bg-stone-100 text-stone-600",
    cannotApprove: "bg-amber-100 text-amber-900",
  } as const;
  const label = {
    ok: t("eligibilityOk"),
    paused: t("eligibilityPaused"),
    cannotApprove: t("eligibilityCannot"),
  } as const;
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${map[eligibility]}`}>
      {label[eligibility]}
    </span>
  );
}

function PositionCard({
  row,
  bad,
  members,
  memberById,
  usedByCategories,
  onPatch,
  onDelete,
}: {
  row: Row;
  bad: boolean;
  members: Member[];
  memberById: Map<string, Member>;
  usedByCategories: string[];
  onPatch: (key: string, next: Partial<Row>) => void;
  onDelete: (row: Row) => void;
}) {
  const t = useTranslations("Positions");
  const tRole = useTranslations("Common.role");
  const locale = useLocale();
  const positionLabel = usePositionLabel();
  const roleLabel = (r: string) => {
    const key = roleLabelKey(r);
    return key ? tRole(key) : r;
  };
  // A built-in role's name is a localized, canonical value — show it read-only
  // (in the active locale) so saving never overwrites the English handle the
  // localization keys off. Custom, treasurer-authored roles stay editable.
  const isBuiltin = builtinPositionKey(row.name) !== null;

  const available = members.filter((m) => !row.holderIds.includes(m.userId));
  const addHolder = (userId: string) => {
    if (userId) onPatch(row.key, { holderIds: [...row.holderIds, userId] });
  };
  const removeHolder = (userId: string) =>
    onPatch(row.key, { holderIds: row.holderIds.filter((id) => id !== userId) });
  const makePrimary = (userId: string) =>
    onPatch(row.key, { holderIds: [userId, ...row.holderIds.filter((id) => id !== userId)] });

  return (
    <div className={`card space-y-3 p-4 ${row.active ? "" : "opacity-70"}`} data-testid="position-card">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 space-y-2">
          {isBuiltin ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="position-name">
              <span className="font-semibold text-stone-800">{positionLabel(row.name)}</span>
              <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-semibold text-stone-500">
                {t("builtinBadge")}
              </span>
            </div>
          ) : (
            <div className="space-y-1.5">
              <input
                className={`input font-semibold ${bad ? "border-red-400 ring-1 ring-red-300" : ""}`}
                value={row.name}
                placeholder={t("namePlaceholder")}
                aria-label={t("nameEnLabel")}
                onChange={(e) => onPatch(row.key, { name: e.target.value })}
                data-testid="position-name"
              />
              {/* Optional per-language names — shown to people using that
                  language, English used as the fallback when left blank. */}
              <div className="flex flex-wrap gap-1.5">
                <input
                  className="input min-w-0 flex-1 text-sm"
                  value={row.nameZhHans}
                  placeholder={t("nameZhHansPlaceholder")}
                  aria-label={t("nameZhHansPlaceholder")}
                  onChange={(e) => onPatch(row.key, { nameZhHans: e.target.value })}
                  data-testid="position-name-zh-hans"
                />
                <input
                  className="input min-w-0 flex-1 text-sm"
                  value={row.nameZhHant}
                  placeholder={t("nameZhHantPlaceholder")}
                  aria-label={t("nameZhHantPlaceholder")}
                  onChange={(e) => onPatch(row.key, { nameZhHant: e.target.value })}
                  data-testid="position-name-zh-hant"
                />
              </div>
            </div>
          )}
          <input
            className="input text-sm text-stone-600"
            value={row.description}
            placeholder={t("descriptionPlaceholder")}
            aria-label={t("descriptionPlaceholder")}
            onChange={(e) => onPatch(row.key, { description: e.target.value })}
          />
          <p className="text-xs text-stone-400">
            {usedByCategories.length === 0
              ? t("usedByNone")
              : t("usedByCategories", {
                  list: new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
                    usedByCategories
                  ),
                })}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <button
            type="button"
            role="switch"
            aria-checked={row.active}
            onClick={() => onPatch(row.key, { active: !row.active })}
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
              row.active ? "bg-emerald-100 text-emerald-800" : "bg-stone-200 text-stone-600"
            }`}
            data-testid="position-active-toggle"
          >
            {row.active ? t("active") : t("archived")}
          </button>
          {/* Delete is a deliberate second step: archive first (it stops
              routing), then the Delete affordance appears on the dormant row. */}
          {!row.active && (
            <button
              type="button"
              onClick={() => onDelete(row)}
              className="text-xs font-medium text-red-600 hover:underline"
              data-testid="delete-position"
            >
              {t("delete")}
            </button>
          )}
        </div>
      </div>

      <div className="border-t border-stone-100 pt-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">{t("holders")}</p>
        {row.holderIds.length === 0 && (
          <p className="mt-1 text-sm text-stone-400">{t("noHolders")}</p>
        )}
        <div className="mt-2 space-y-2">
          {row.holderIds.map((userId, i) => {
            const m = memberById.get(userId);
            const eligibility = m?.eligibility ?? "cannotApprove";
            return (
              <div key={userId} data-testid="position-holder">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{m?.name ?? userId}</span>
                  {m && (
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ROLE_STYLE[m.role] ?? ROLE_STYLE.member}`}>
                      {roleLabel(m.role)}
                    </span>
                  )}
                  {i === 0 ? (
                    <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700">
                      {t("primary")}
                    </span>
                  ) : (
                    <button
                      className="text-xs font-medium text-indigo-700 hover:underline"
                      onClick={() => makePrimary(userId)}
                    >
                      {t("makePrimary")}
                    </button>
                  )}
                  <span className="flex-1" />
                  <EligibilityBadge eligibility={eligibility} />
                  <button
                    className="text-xs font-medium text-red-600 hover:underline"
                    onClick={() => removeHolder(userId)}
                    data-testid="remove-holder"
                  >
                    {t("removeHolder")}
                  </button>
                </div>
                {eligibility !== "ok" && (
                  <p className="mt-1 rounded-lg bg-amber-50 p-2 text-xs text-amber-900" data-testid="holder-warning">
                    ⚠{" "}
                    {eligibility === "paused"
                      ? t("holderPausedWarn", { name: m?.name ?? "" })
                      : t.rich("holderCannotWarn", {
                          name: m?.name ?? "",
                          link: (chunks) => (
                            <Link href="/members" className="underline">
                              {chunks}
                            </Link>
                          ),
                        })}
                  </p>
                )}
              </div>
            );
          })}
        </div>
        {available.length > 0 && (
          <label className="mt-3 block text-xs font-medium text-stone-500">
            {t("addHolder")}
            <select
              className="input mt-1 text-sm"
              value=""
              onChange={(e) => addHolder(e.target.value)}
              data-testid="add-holder"
            >
              <option value="">{t("choosePerson")}</option>
              {available.map((m) => (
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
