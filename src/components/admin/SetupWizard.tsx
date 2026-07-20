"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useThrownErrorMessage } from "@/lib/use-api-error";
import { FieldRow, type Field } from "./FieldRow";
import type { Wizard } from "@/lib/admin/wizards";

/**
 * Guided setup wizard (docs/ADMIN.md): one service, walked step by step, with
 * a per-step dry-run "Test" (POST /api/admin/setup/validate — no persistence)
 * and a "Save & continue" that writes only that step's fields. Config-backed
 * wizards use the allowlisted config editor; the search wizard uses the
 * embeddings backend. The stepper itself is service-agnostic.
 */

type Check = { status: "ok" | "warn" | "fail"; code: string; params?: Record<string, string | number> };

const STATUS_STYLE: Record<Check["status"], string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
  fail: "border-red-200 bg-red-50 text-red-700",
};
const STATUS_ICON: Record<Check["status"], string> = { ok: "✓", warn: "!", fail: "✗" };

export default function SetupWizard({
  wizard,
  onClose,
  onConfigured,
}: {
  wizard: Wizard;
  onClose: () => void;
  onConfigured: () => void;
}) {
  const t = useTranslations("Admin");
  const tx = t as unknown as ((k: string, p?: Record<string, string | number>) => string) & {
    has: (k: string) => boolean;
  };
  const thrown = useThrownErrorMessage();

  const [fields, setFields] = useState<Record<string, Field> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [stepIdx, setStepIdx] = useState(0);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const searchLabel = useCallback(
    (key: string, part: "label" | "help") => {
      const k = `searchFields.${key}.${part}`;
      return tx.has(k) ? tx(k) : key;
    },
    [tx]
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      if (wizard.backend === "search") {
        const res = await fetch("/api/admin/embeddings");
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
        const data = (await res.json()) as {
          settings: {
            endpoint: string;
            model: string;
            minScore: number;
            enabled: boolean;
            apiKeySet: boolean;
          } | null;
        };
        const s = data.settings;
        const map: Record<string, Field> = {};
        for (const def of wizard.searchFields ?? []) {
          const current =
            def.key === "endpoint"
              ? s?.endpoint ?? ""
              : def.key === "model"
                ? s?.model ?? ""
                : def.key === "minScore"
                  ? String(s?.minScore ?? 0.25)
                  : def.key === "enabled"
                    ? s?.enabled
                      ? "1"
                      : ""
                    : ""; // apiKey — write-only
          map[def.key] = {
            key: def.key,
            group: "search",
            type: def.type,
            secret: !!def.secret,
            options: null,
            onValue: def.onValue ?? null,
            min: def.min ?? null,
            max: def.max ?? null,
            placeholder: def.placeholder ?? null,
            fromFile: false,
            set: def.key === "apiKey" ? !!s?.apiKeySet : !!current,
            value: current,
            label: searchLabel(def.key, "label"),
            help: searchLabel(def.key, "help"),
          };
        }
        setFields(map);
        setDraft(Object.fromEntries(Object.values(map).map((f) => [f.key, f.value])));
      } else {
        const res = await fetch("/api/admin/config");
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
        const data = (await res.json()) as { fields: Field[] };
        const keys = new Set(wizard.steps.flatMap((s) => s.fieldKeys));
        const map: Record<string, Field> = {};
        for (const f of data.fields) if (keys.has(f.key)) map[f.key] = f;
        setFields(map);
        setDraft(Object.fromEntries(Object.values(map).map((f) => [f.key, f.value])));
      }
      setCleared(new Set());
    } catch (err) {
      setError(thrown(err, t("loadFailed")));
    }
  }, [wizard, searchLabel, t, thrown]);

  useEffect(() => {
    void load();
  }, [load]);

  const step = wizard.steps[stepIdx];
  const isLast = stepIdx === wizard.steps.length - 1;

  const setValue = (key: string, v: string) => {
    setDraft((d) => ({ ...d, [key]: v }));
    setChecks(null);
    setCleared((c) => {
      if (!c.has(key)) return c;
      const next = new Set(c);
      next.delete(key);
      return next;
    });
  };

  async function runTest() {
    setTesting(true);
    setError(null);
    setChecks(null);
    try {
      const res = await fetch("/api/admin/setup/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: wizard.service, values: draft }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
      const data = (await res.json()) as { checks: Check[] };
      setChecks(data.checks);
    } catch (err) {
      setError(thrown(err, t("wizardTestFailed")));
    } finally {
      setTesting(false);
    }
  }

  // Persist only the current step's fields, then advance (or finish).
  async function saveAndNext() {
    if (!step || !fields) return;
    setSaving(true);
    setError(null);
    try {
      if (wizard.backend === "search") {
        const body: Record<string, unknown> = {};
        for (const key of step.fieldKeys) {
          const v = draft[key] ?? "";
          if (key === "apiKey") {
            if (v.trim()) body.apiKey = v.trim();
          } else if (key === "enabled") {
            body.enabled = v === "1";
          } else if (key === "minScore") {
            const n = Number(v);
            if (Number.isFinite(n)) body.minScore = n;
          } else {
            body[key] = v.trim();
          }
        }
        const res = await fetch("/api/admin/embeddings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
      } else {
        const values: Record<string, string> = {};
        const clear: string[] = [];
        for (const key of step.fieldKeys) {
          const f = fields[key];
          if (!f) continue;
          const current = draft[key] ?? "";
          if (cleared.has(key)) clear.push(key);
          else if (f.secret) {
            if (current.trim() !== "") values[key] = current;
          } else if (current !== f.value) values[key] = current;
        }
        if (Object.keys(values).length > 0 || clear.length > 0) {
          const res = await fetch("/api/admin/config", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ values, clear }),
          });
          if (!res.ok) throw new Error((await res.json().catch(() => null))?.error);
        }
      }
      setChecks(null);
      if (isLast) {
        setDone(true);
        onConfigured();
      } else {
        setStepIdx((i) => i + 1);
        await load(); // re-read so freshly-saved secrets show their "set" state
      }
    } catch (err) {
      setError(thrown(err, t("saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  const stepFields = useMemo(
    () => (step && fields ? step.fieldKeys.map((k) => fields[k]).filter(Boolean) : []),
    [step, fields]
  );

  if (!fields && !error) {
    return (
      <div className="card p-6" data-testid={`wizard-${wizard.service}`}>
        <p className="text-sm text-stone-400">{t("loading")}</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="card space-y-4 p-6" data-testid={`wizard-${wizard.service}`}>
        <div className="flex items-center gap-3">
          <span aria-hidden className="text-2xl">{wizard.icon}</span>
          <h2 className="text-lg font-bold">{tx(`wizard.${wizard.service}.title`)}</h2>
        </div>
        <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800" data-testid="wizard-done">
          {tx(`wizard.${wizard.service}.done`)}
        </p>
        <button className="btn-primary" onClick={onClose} data-testid="wizard-finish">
          {t("wizardFinish")}
        </button>
      </div>
    );
  }

  return (
    <div className="card space-y-4 p-6" data-testid={`wizard-${wizard.service}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span aria-hidden className="text-2xl">{wizard.icon}</span>
          <div>
            <h2 className="text-lg font-bold">{tx(`wizard.${wizard.service}.title`)}</h2>
            <p className="text-xs text-stone-500" data-testid="wizard-progress">
              {t("wizardStepOf", { n: stepIdx + 1, total: wizard.steps.length })}
            </p>
          </div>
        </div>
        <button className="btn-secondary shrink-0" onClick={onClose} data-testid="wizard-close">
          {t("wizardCancel")}
        </button>
      </div>

      {/* Step rail */}
      <ol className="flex flex-wrap gap-1.5" aria-hidden>
        {wizard.steps.map((s, i) => (
          <li
            key={s.id}
            className={`h-1.5 flex-1 rounded-full ${
              i < stepIdx ? "bg-emerald-500" : i === stepIdx ? "bg-indigo-500" : "bg-stone-200"
            }`}
          />
        ))}
      </ol>

      <div>
        <h3 className="font-semibold" data-testid="wizard-step-title">
          {tx(`wizard.${wizard.service}.steps.${step.id}.title`)}
        </h3>
        <p className="mt-0.5 text-sm text-stone-500">
          {tx(`wizard.${wizard.service}.steps.${step.id}.intro`)}
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 p-2 text-sm text-red-700" data-testid="wizard-error">
          {error}
        </p>
      )}

      <div className="space-y-3">
        {stepFields.map((f) => (
          <FieldRow
            key={f.key}
            field={f}
            value={draft[f.key] ?? ""}
            cleared={cleared.has(f.key)}
            onChange={(v) => setValue(f.key, v)}
            onClear={() => setCleared((c) => new Set(c).add(f.key))}
          />
        ))}
      </div>

      {step.test && (
        <div className="space-y-2">
          <button
            className="btn-secondary"
            onClick={() => void runTest()}
            disabled={testing}
            data-testid="wizard-test"
          >
            {testing ? t("wizardTesting") : t("wizardTest")}
          </button>
          {checks && (
            <ul className="space-y-1.5" data-testid="wizard-checks">
              {checks.map((c, i) => {
                const key = `checks.${c.code}`;
                const text = tx.has(key) ? tx(key, c.params) : c.code;
                return (
                  <li
                    key={`${c.code}-${i}`}
                    data-testid="wizard-check"
                    data-status={c.status}
                    className={`flex items-start gap-2 rounded-lg border p-2 text-sm ${STATUS_STYLE[c.status]}`}
                  >
                    <span aria-hidden className="font-bold">{STATUS_ICON[c.status]}</span>
                    <span>{text}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-stone-100 pt-3">
        {stepIdx > 0 && (
          <button
            className="btn-secondary"
            onClick={() => {
              setChecks(null);
              setStepIdx((i) => i - 1);
            }}
            disabled={saving}
            data-testid="wizard-back"
          >
            {t("wizardBack")}
          </button>
        )}
        <button
          className="btn-primary"
          onClick={() => void saveAndNext()}
          disabled={saving}
          data-testid="wizard-next"
        >
          {saving ? t("saving") : isLast ? t("wizardSaveFinish") : t("wizardSaveNext")}
        </button>
      </div>
    </div>
  );
}
