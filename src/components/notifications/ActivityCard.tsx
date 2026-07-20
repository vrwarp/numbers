"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { KIND_SPECS, type NotificationKind } from "@/lib/notifications/catalog";

/**
 * §5 in-app parity: the recent-activity list — every member sees the same
 * facts as push recipients, merely later. Informational only: no unread
 * counts, no read-tracking (§2); badges stay the actionable surface. Text is
 * composed here at RENDER time in the viewer's locale from event params.
 */

type Item = {
  id: string;
  kind: NotificationKind;
  targetId: string;
  createdAt: string;
  label: string;
  name: string;
  targetGone: boolean;
};

export default function ActivityCard() {
  const t = useTranslations("Notifications");
  const format = useFormatter();
  const [items, setItems] = useState<Item[] | null>(null);

  useEffect(() => {
    fetch("/api/notifications/activity?limit=10")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { items: Item[] } | null) => setItems(data?.items ?? []))
      .catch(() => setItems([]));
  }, []);

  // The activity list shares the push catalog's key contract (§9) — one
  // vocabulary, composed server-side for lock screens and here for the page.
  function titleOf(item: Item): string {
    const label = item.targetGone ? t("activity.deletedClaim") : item.label;
    switch (item.kind) {
      case "signing-request":
        return label ? t("push.signingRequest.title", { label }) : t("push.signingRequest.titleBare");
      case "claim-approved":
        return label ? t("push.claimApproved.title", { label }) : t("push.claimApproved.titleBare");
      case "claim-rejected":
        return label ? t("push.claimRejected.title", { label }) : t("push.claimRejected.titleBare");
      case "finance-queue":
        return label
          ? t("push.financeQueue.bodySingle", { label })
          : t("push.financeQueue.title", { count: 1 });
      case "claim-paid":
        return label ? t("push.claimPaid.title", { label }) : t("push.claimPaid.titleBare");
      case "device-request":
        return t("push.deviceRequest.title");
      case "self-test":
        return t("push.selfTest.title");
    }
  }

  if (items === null || items.length === 0) {
    // The card renders only once there is something to show — an empty
    // activity box would just be noise on the home screen.
    return null;
  }

  return (
    <section className="card mt-6 p-5" aria-labelledby="activity-title" id="activity" data-testid="activity-card">
      <h2 id="activity-title" className="text-lg font-bold">
        {t("activity.title")}
      </h2>
      <ul className="mt-2 divide-y divide-stone-100">
        {items.map((item) => {
          const route = item.targetGone ? null : KIND_SPECS[item.kind].route(item.targetId);
          const body = (
            <>
              <span className="block text-sm">{titleOf(item)}</span>
              <span className="mt-0.5 block text-xs text-stone-400">
                {item.name && <>{t("activity.byName", { name: item.name })} · </>}
                {format.dateTime(new Date(item.createdAt), { dateStyle: "medium", timeStyle: "short" })}
              </span>
            </>
          );
          return (
            <li key={item.id} className="py-2">
              {route ? (
                <Link href={route} className="block rounded-lg px-1 py-0.5 hover:bg-stone-50">
                  {body}
                </Link>
              ) : (
                <span className="block px-1 py-0.5 text-stone-400">{body}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
