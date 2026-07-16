import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { canManageMinistries } from "@/lib/ministries-guard";
import BudgetCategories from "@/components/BudgetCategories";

export const dynamic = "force-dynamic";

/**
 * Treasurer's Budget Categories editor. Gated like every privileged surface: a
 * caller who may not edit the chart of accounts is bounced home as if the page
 * didn't exist (the API returns 404), never a visible 403.
 */
export default async function MinistriesPage() {
  const user = await currentUser();
  if (!user) redirect("/signin");
  if (!canManageMinistries(user)) redirect("/");
  return <BudgetCategories />;
}
