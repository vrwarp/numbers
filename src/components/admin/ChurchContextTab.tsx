"use client";

/**
 * Church context editor (docs/ADMIN.md — the main admin job): the operator-
 * authored vocabulary doc fed into every "Suggest ministry" call. Edited here
 * instead of by hand on the /data volume; saved changes are hot-reloaded. The
 * document is church DATA sent to the AI provider, so its starter scaffold is a
 * plain constant, not a localized string.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useThrownErrorMessage } from "@/lib/use-api-error";

const STARTER = `# Vocabulary & aliases

- "the retreat" usually means the all-church Summer Retreat.
- Small groups: (list your fellowships and their aliases here).

# Recurring events

- Summer Retreat — (month / place).
- VBS — (month).

# Labeling rules

- Food/snack purchases default to (category) unless tied to a named event.
- Cleaning & paper goods for the building are Janitorial, not Office Supplies.
`;

export default function ChurchContextTab() {
  const t = useTranslations("Admin");
  const thrown = useThrownErrorMessage();
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [path, setPath] = useState("");
  const [maxBytes, setMaxBytes] = useState(16 * 1024);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/church-context");
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
      const data = (await res.json()) as { content: string; path: string; maxBytes: number };
      setContent(data.content);
      setSaved(data.content);
      setPath(data.path);
      setMaxBytes(data.maxBytes);
    } catch (err) {
      setError(thrown(err, t("loadFailed")));
    }
  }, [t, thrown]);

  useEffect(() => {
    void load();
  }, [load]);

  const bytes = content === null ? 0 : new TextEncoder().encode(content).length;
  const over = bytes > maxBytes;
  const dirty = content !== null && content !== saved;

  async function save() {
    if (content === null) return;
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      const res = await fetch("/api/admin/church-context", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
      setSaved(content);
      setOk(true);
    } catch (err) {
      setError(thrown(err, t("saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  if (content === null && !error) {
    return <p className="text-sm text-stone-400">{t("loading")}</p>;
  }

  return (
    <div className="space-y-3" data-testid="context-tab">
      <div className="card space-y-2 p-4">
        <h2 className="font-semibold">{t("contextTitle")}</h2>
        <p className="text-sm text-stone-600">{t("contextIntro")}</p>
        <p className="rounded-lg bg-amber-50 p-2.5 text-xs text-amber-900">⚠ {t("contextPrivacy")}</p>
      </div>

      {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {ok && !dirty && (
        <p className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-800" data-testid="context-saved">
          {t("contextSavedNote")}
        </p>
      )}

      <textarea
        className="input min-h-[22rem] w-full font-mono text-sm leading-relaxed"
        value={content ?? ""}
        onChange={(e) => {
          setContent(e.target.value);
          setOk(false);
        }}
        spellCheck={false}
        data-testid="context-editor"
        placeholder={t("contextPlaceholder")}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className={over ? "font-semibold text-red-600" : "text-stone-400"} data-testid="context-bytes">
          {t("bytesOf", { bytes, max: maxBytes })}
        </span>
        <span className="break-all text-stone-400">{t("fileAt", { path })}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          className="btn-primary"
          disabled={busy || over || !dirty}
          onClick={save}
          data-testid="context-save"
        >
          {busy ? t("saving") : dirty ? t("save") : t("saved")}
        </button>
        {!content?.trim() && (
          <button className="btn-secondary" onClick={() => setContent(STARTER)} data-testid="context-starter">
            {t("insertStarter")}
          </button>
        )}
        {dirty && (
          <button className="btn-secondary" onClick={() => setContent(saved)}>
            {t("revert")}
          </button>
        )}
      </div>
    </div>
  );
}
