"use client";

import { useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";

/**
 * §12 push health, read-only and strictly aggregate — process questions
 * ("is sending working"), never per-person visibility. The pause switch and
 * every config value live in the settings editor above this card.
 */

type Health = {
  configured: boolean;
  mock: boolean;
  paused: boolean;
  queueDepth: number;
  failedLast24h: number;
  lastSentAt: string | null;
  devices: number | null;
  saFingerprint: string | null;
  saScope: "ok" | "broad" | "unknown" | "mock" | "unconfigured";
};

export default function NotificationsHealthCard() {
  const t = useTranslations("Admin");
  const format = useFormatter();
  const [health, setHealth] = useState<Health | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/api/admin/notifications")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setHealth)
      .catch(() => setFailed(true));
  }, []);

  return (
    <section className="card p-5" aria-labelledby="push-health-title" data-testid="push-health-card">
      <h2 id="push-health-title" className="font-semibold">
        {t("pushHealthTitle")}
      </h2>
      {failed && <p className="mt-2 text-sm text-red-700">{t("pushHealthLoadFailed")}</p>}
      {!health && !failed && <p className="mt-2 text-sm text-stone-400">…</p>}
      {health && (
        <dl className="mt-2 space-y-1 text-sm">
          <div className="flex justify-between gap-2">
            <dt className="text-stone-500">{t("pushHealthState")}</dt>
            <dd className="font-medium">
              {!health.configured
                ? t("pushHealthOff")
                : health.paused
                  ? t("pushHealthPaused")
                  : health.mock
                    ? t("pushHealthMock")
                    : t("pushHealthOn")}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-stone-500">{t("pushHealthQueue")}</dt>
            <dd className="font-medium">{health.queueDepth}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-stone-500">{t("pushHealthFailed")}</dt>
            <dd className={`font-medium ${health.failedLast24h > 0 ? "text-amber-700" : ""}`}>
              {health.failedLast24h}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-stone-500">{t("pushHealthLastSent")}</dt>
            <dd className="font-medium">
              {health.lastSentAt
                ? format.dateTime(new Date(health.lastSentAt), { dateStyle: "medium", timeStyle: "short" })
                : t("pushHealthNever")}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-stone-500">{t("pushHealthDevices")}</dt>
            {/* §12: floored at small N — a count of 3 is a named person here. */}
            <dd className="font-medium">{health.devices === null ? t("pushHealthFewer") : health.devices}</dd>
          </div>
          {health.saFingerprint && (
            <div className="flex justify-between gap-2">
              <dt className="text-stone-500">{t("pushHealthSa")}</dt>
              <dd className="break-all font-mono text-xs">{health.saFingerprint}</dd>
            </div>
          )}
        </dl>
      )}
      {health?.saScope === "broad" && (
        <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">
          {t("pushHealthScopeBroad")}
        </p>
      )}
      {health?.saScope === "ok" && (
        <p className="mt-3 text-xs text-emerald-700" role="status">
          {t("pushHealthScopeOk")}
        </p>
      )}
    </section>
  );
}
