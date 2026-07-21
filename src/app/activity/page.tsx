import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { currentUserId, signInPath } from "@/auth";
import ActivityCard from "@/components/notifications/ActivityCard";

export const dynamic = "force-dynamic";

/**
 * Recent activity — the §5 in-app parity list on its own page, reached from
 * the account menu. Every signed-in member sees their own NotificationJob feed
 * (owner-scoped in the API, invariant 2); the list itself hydrates client-side
 * in ActivityCard. Informational only — no read-tracking (§2).
 */
export default async function ActivityPage() {
  const userId = await currentUserId();
  if (!userId) redirect(signInPath("/activity"));

  const t = await getTranslations("Notifications.activity");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-stone-500">{t("subtitle")}</p>
      </div>
      <ActivityCard />
    </div>
  );
}
