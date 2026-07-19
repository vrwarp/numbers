"use client";

/**
 * Admin dashboard shell (docs/ADMIN.md): seven tabs. Church Context is the main
 * job; the rest (settings, usage, logs, members/roster) round out the
 * comprehensive admin surface. Church Context / Settings / Usage / Logs work
 * with e-sign off; only Members leans on the roster.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import OverviewTab from "./OverviewTab";
import ChurchContextTab from "./ChurchContextTab";
import SettingsTab from "./SettingsTab";
import UsageTab from "./UsageTab";
import LogsTab from "./LogsTab";
import MembersTab from "./MembersTab";
import SearchIndexTab from "./SearchIndexTab";

const TABS = ["overview", "context", "settings", "search", "usage", "logs", "members"] as const;
type Tab = (typeof TABS)[number];

export default function AdminDashboard() {
  const t = useTranslations("Admin");
  // next-intl types t() to literal keys; these are built from a fixed enum.
  const tx = t as unknown as (k: string) => string;
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div className="space-y-5" data-testid="admin-dashboard">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="mt-0.5 text-sm text-stone-500">{t("subtitle")}</p>
      </div>

      <nav className="-mx-1 flex gap-1 overflow-x-auto border-b border-stone-200 pb-px" aria-label={t("title")}>
        {TABS.map((id) => {
          const active = id === tab;
          return (
            <button
              key={id}
              onClick={() => setTab(id)}
              data-testid={`admin-tab-${id}`}
              className={`whitespace-nowrap rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium ${
                active
                  ? "border-indigo-600 text-indigo-700"
                  : "border-transparent text-stone-500 hover:bg-stone-50 hover:text-stone-700"
              }`}
            >
              {tx(`tab_${id}`)}
            </button>
          );
        })}
      </nav>

      <div>
        {tab === "overview" && <OverviewTab onNavigate={setTab} />}
        {tab === "context" && <ChurchContextTab />}
        {tab === "settings" && <SettingsTab />}
        {tab === "search" && <SearchIndexTab />}
        {tab === "usage" && <UsageTab />}
        {tab === "logs" && <LogsTab />}
        {tab === "members" && <MembersTab />}
      </div>
    </div>
  );
}

export type { Tab };
