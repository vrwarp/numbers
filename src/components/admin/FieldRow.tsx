"use client";

import { useTranslations } from "next-intl";

/**
 * One config field row (docs/ADMIN.md). Shared by the plain settings editor
 * (SettingsTab) and the guided setup wizard (SetupWizard). Secrets render as a
 * write-only password input with a "set" badge and a Clear affordance; labels
 * and help come from Admin.fields_<KEY>_{label,help}, with per-wizard overrides
 * passed in for fields that don't live in the config allowlist (search).
 */
export interface Field {
  key: string;
  group: string;
  type: "text" | "number" | "boolean" | "select";
  secret: boolean;
  options: string[] | null;
  onValue: string | null;
  min: number | null;
  max: number | null;
  placeholder: string | null;
  fromFile: boolean;
  set: boolean;
  value: string;
  /** Optional literal label/help, used when the key isn't in Admin.fields_*. */
  label?: string;
  help?: string;
}

export function FieldRow({
  field,
  value,
  cleared,
  onChange,
  onClear,
}: {
  field: Field;
  value: string;
  cleared: boolean;
  onChange: (v: string) => void;
  onClear: () => void;
}) {
  const t = useTranslations("Admin");
  const tx = t as unknown as ((k: string) => string) & { has: (k: string) => boolean };
  const label = field.label ?? tx(`fields_${field.key}_label`);
  const help = field.help ?? tx(`fields_${field.key}_help`);

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm font-medium" htmlFor={`cfg-${field.key}`}>
          {label}
        </label>
        <code className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-500">{field.key}</code>
        {field.secret && field.set && !cleared && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
            {t("secretSet")}
          </span>
        )}
        {cleared && (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">
            {t("willClear")}
          </span>
        )}
      </div>

      {field.type === "boolean" ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            id={`cfg-${field.key}`}
            type="checkbox"
            checked={value === (field.onValue ?? "1")}
            onChange={(e) => onChange(e.target.checked ? field.onValue ?? "1" : "")}
            data-testid={`cfg-${field.key}`}
          />
          <span className="text-stone-600">{help}</span>
        </label>
      ) : field.type === "select" ? (
        <>
          <select
            id={`cfg-${field.key}`}
            className="input"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            data-testid={`cfg-${field.key}`}
          >
            {(field.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <p className="text-xs text-stone-400">{help}</p>
        </>
      ) : (
        <>
          <div className="flex gap-2">
            <input
              id={`cfg-${field.key}`}
              className="input"
              type={field.secret ? "password" : field.type === "number" ? "number" : "text"}
              value={value}
              min={field.min ?? undefined}
              max={field.max ?? undefined}
              autoComplete={field.secret ? "new-password" : "off"}
              placeholder={field.secret && field.set ? t("secretKeepPlaceholder") : field.placeholder ?? ""}
              onChange={(e) => onChange(e.target.value)}
              data-testid={`cfg-${field.key}`}
            />
            {field.secret && field.set && !cleared && (
              <button type="button" className="btn-soft-danger shrink-0" onClick={onClear}>
                {t("clear")}
              </button>
            )}
          </div>
          <p className="text-xs text-stone-400">{help}</p>
        </>
      )}
    </div>
  );
}
