import { redirect } from "next/navigation";
import { currentUser, signInPath } from "@/auth";
import { canManageTeams } from "@/lib/teams-guard";
import Teams from "@/components/Teams";

export const dynamic = "force-dynamic";

/**
 * Teams editor (read-only visibility groups over budget categories). Gated to
 * Approver-or-above (or app-admin) — a caller who may not manage teams is
 * bounced home as if the page didn't exist (the API returns 404), never a
 * visible 403.
 */
export default async function TeamsPage() {
  const user = await currentUser();
  if (!user) redirect(signInPath("/teams"));
  if (!canManageTeams(user)) redirect("/");
  return <Teams />;
}
