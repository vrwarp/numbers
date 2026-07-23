"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { WIZARDS, type Wizard } from "@/lib/admin/wizards";
import SetupWizard from "./SetupWizard";
import RulesCard from "./RulesCard";

/**
 * Setup tab (docs/ADMIN.md): a launcher of guided, per-service configuration
 * wizards. Each card shows whether the service is already configured; opening
 * one walks the admin through it with a dry-run test on the steps that can be
 * validated. Ongoing tweaks still live in Settings / Search — this is the
 * "get it working the first time" surface.
 */

type Status = "configured" | "unconfigured" | "mock";

export default function SetupTab() {
  const t = useTranslations("Admin");
  const tx = t as unknown as (k: string) => string;
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [active, setActive] = useState<Wizard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [cfgRes, embRes, pushRes] = await Promise.all([
        fetch("/api/admin/config"),
        fetch("/api/admin/embeddings"),
        fetch("/api/admin/notifications"),
      ]);
      const cfg = cfgRes.ok
        ? ((await cfgRes.json()) as { fields: { key: string; set: boolean }[] })
        : { fields: [] };
      const setKeys = new Set(cfg.fields.filter((f) => f.set).map((f) => f.key));
      const emb = embRes.ok ? ((await embRes.json()) as { settings: { enabled: boolean } | null }) : { settings: null };
      const push = pushRes.ok ? ((await pushRes.json()) as { mock: boolean }) : { mock: false };

      const next: Record<string, Status> = {};
      for (const w of WIZARDS) {
        if (w.service === "search") {
          next.search = emb.settings?.enabled ? "configured" : "unconfigured";
        } else if (w.service === "push" && push.mock) {
          next.push = "mock";
        } else {
          next[w.service] = (w.configuredKeys ?? []).some((k) => setKeys.has(k))
            ? "configured"
            : "unconfigured";
        }
      }
      setStatuses(next);
    } catch {
      setError(t("loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (active) {
    return (
      <SetupWizard
        wizard={active}
        onClose={() => {
          setActive(null);
          void refresh();
        }}
        onConfigured={() => void refresh()}
      />
    );
  }

  return (
    <div className="space-y-4" data-testid="setup-tab">
      <p className="text-sm text-stone-600">{t("setupIntro")}</p>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        {WIZARDS.map((w) => {
          const status = statuses[w.service] ?? "unconfigured";
          return (
            <div
              key={w.service}
              className="card flex flex-col gap-3 p-4"
              data-testid={`wizard-card-${w.service}`}
            >
              <div className="flex items-start gap-3">
                <span aria-hidden className="text-2xl">{w.icon}</span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{tx(`wizard.${w.service}.title`)}</h3>
                    <StatusBadge status={status} service={w.service} t={t} />
                  </div>
                  <p className="mt-0.5 text-sm text-stone-500">{tx(`wizard.${w.service}.blurb`)}</p>
                </div>
              </div>
              <div className="mt-auto">
                <button
                  className={status === "configured" ? "btn-secondary" : "btn-primary"}
                  onClick={() => setActive(w)}
                  data-testid={`wizard-launch-${w.service}`}
                >
                  {status === "configured" ? t("wizardReconfigure") : t("wizardSetUp")}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <RulesCard />
    </div>
  );
}

function StatusBadge({
  status,
  service,
  t,
}: {
  status: Status;
  service: string;
  t: ReturnType<typeof useTranslations<"Admin">>;
}) {
  const style =
    status === "configured"
      ? "bg-emerald-100 text-emerald-800"
      : status === "mock"
        ? "bg-indigo-100 text-indigo-700"
        : "bg-stone-100 text-stone-600";
  const label = status === "configured" ? t("wizardConfigured") : status === "mock" ? t("wizardMock") : t("wizardNeedsSetup");
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${style}`}
      data-testid={`wizard-status-${service}`}
      data-status={status}
    >
      {label}
    </span>
  );
}
