"use client";

import { useEffect, useState } from "react";
import { useTranslations, useFormatter } from "next-intl";
import { useApiErrorMessage } from "@/lib/use-api-error";

/**
 * Proposed Changes review (docs/MCP_DESIGN.md): pending catalog-edit drafts an
 * AI assistant staged, grouped by entity, each with Apply / Discard. Only
 * sections the account can manage are shown. Apply/discard re-check the role
 * server-side — the buttons are convenience, the API is the gate.
 */

type Entity = "ministry" | "team" | "position";

interface Drift {
  targetGone: boolean;
  conflicts: string[];
  current: Record<string, unknown> | null;
}
interface Draft {
  id: string;
  entity: Entity;
  operation: "create" | "update" | "archive" | "delete";
  targetId: string | null;
  targetLabel: string | null;
  fields: Record<string, unknown>;
  note: string | null;
  createdAt: string;
  author?: { name: string; email: string };
  drift?: Drift | null;
}

function fmtValue(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

function fieldSummary(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
    .join("; ");
}

export default function CatalogDraftsReview() {
  const t = useTranslations("CatalogDrafts");
  const format = useFormatter();
  const apiError = useApiErrorMessage();

  // next-intl keys must be literals — map enum values to translated labels.
  const sectionLabel: Record<Entity, string> = {
    ministry: t("sectionMinistry"),
    team: t("sectionTeam"),
    position: t("sectionPosition"),
  };
  const opLabel: Record<Draft["operation"], string> = {
    create: t("opCreate"),
    update: t("opUpdate"),
    archive: t("opArchive"),
    delete: t("opDelete"),
  };

  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [manageable, setManageable] = useState<Entity[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    const res = await fetch("/api/catalog-drafts").catch(() => null);
    if (res?.ok) {
      const data = (await res.json()) as { drafts: Draft[]; manageable: Entity[] };
      setDrafts(data.drafts);
      setManageable(data.manageable);
    } else {
      setError(t("loadFailed"));
    }
  }

  async function act(id: string, action: "apply" | "discard") {
    setBusy(`${action}-${id}`);
    setError(null);
    try {
      const res = await fetch(`/api/catalog-drafts/${id}/${action}`, { method: "POST" });
      if (!res.ok) throw new Error(apiError(await res.json().catch(() => null), t("actionFailed")));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // Sections to render: those the user manages, plus any entity that has a draft
  // they authored but no longer manage (so it never gets stranded).
  const entities: Entity[] = ["ministry", "team", "position"].filter(
    (e): e is Entity => manageable.includes(e as Entity) || (drafts ?? []).some((d) => d.entity === e)
  );

  return (
    <section className="card p-5" aria-labelledby="drafts-title" data-testid="catalog-drafts">
      <h1 id="drafts-title" className="text-lg font-bold">
        {t("title")}
      </h1>
      <p className="mt-1 text-sm text-stone-500">{t("subtitle")}</p>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      {drafts && drafts.length === 0 && <p className="mt-4 text-sm text-stone-500">{t("empty")}</p>}

      {entities.map((entity) => {
        const rows = (drafts ?? []).filter((d) => d.entity === entity);
        if (rows.length === 0) return null;
        return (
          <div key={entity} className="mt-5">
            <h2 className="text-sm font-bold">{sectionLabel[entity]}</h2>
            <ul className="mt-2 space-y-2">
              {rows.map((d) => {
                const targetGone = d.drift?.targetGone ?? false;
                const conflicts = d.drift?.conflicts ?? [];
                const blocked = targetGone || conflicts.length > 0;
                // Show a field-by-field diff for updates (the base drifted or
                // not); create/archive/delete keep the plain proposed summary.
                const showDiff = d.operation === "update" && !!d.drift && !targetGone;
                return (
                  <li
                    key={d.id}
                    className={`rounded-xl border p-3 text-sm ${blocked ? "border-amber-300 bg-amber-50" : "border-stone-200"}`}
                    data-testid="draft-row"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                          {opLabel[d.operation]}
                        </span>
                        {d.targetLabel && <span className="ml-2">{t("target", { label: d.targetLabel })}</span>}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={busy === `apply-${d.id}` || blocked}
                          title={blocked ? t("cantApply") : undefined}
                          onClick={() => void act(d.id, "apply")}
                          data-testid="draft-apply"
                        >
                          {busy === `apply-${d.id}` ? t("applying") : t("apply")}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={busy === `discard-${d.id}`}
                          onClick={() => void act(d.id, "discard")}
                          data-testid="draft-discard"
                        >
                          {busy === `discard-${d.id}` ? t("discarding") : t("discard")}
                        </button>
                      </div>
                    </div>

                    {targetGone && (
                      <p className="mt-2 rounded-lg bg-red-50 p-2 text-xs font-medium text-red-700" role="status" data-testid="draft-stale">
                        {t("staleGone", { entity: d.entity })}
                      </p>
                    )}
                    {!targetGone && conflicts.length > 0 && (
                      <p className="mt-2 rounded-lg bg-amber-100 p-2 text-xs font-medium text-amber-800" role="status" data-testid="draft-conflict">
                        {t("staleConflict", { entity: d.entity })}
                      </p>
                    )}

                    {showDiff ? (
                      <div className="mt-2 overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-stone-400">
                              <th className="pr-3 text-left font-medium">·</th>
                              <th className="pr-3 text-left font-medium">{t("proposedLabel")}</th>
                              <th className="text-left font-medium">{t("currentLabel")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.keys(d.fields).map((f) => {
                              const conflict = conflicts.includes(f);
                              return (
                                <tr key={f} className={conflict ? "text-red-700" : "text-stone-600"}>
                                  <td className="pr-3 align-top font-medium">
                                    {f}
                                    {conflict && <span className="ml-1 text-red-500">({t("conflictTag")})</span>}
                                  </td>
                                  <td className="pr-3 align-top">{fmtValue(d.fields[f])}</td>
                                  <td className="align-top text-stone-500">{fmtValue(d.drift?.current?.[f])}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      fieldSummary(d.fields) && (
                        <p className="mt-1 break-words text-stone-600">
                          {t("proposed", { summary: fieldSummary(d.fields) })}
                        </p>
                      )
                    )}

                    {d.note && <p className="mt-1 text-stone-600">{t("note", { note: d.note })}</p>}
                    <p className="mt-1 text-xs text-stone-400">
                      {format.dateTime(new Date(d.createdAt), { dateStyle: "medium" })}
                      {d.author && ` · ${t("by", { name: d.author.name })}`}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
