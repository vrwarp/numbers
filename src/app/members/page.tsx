import { redirect } from "next/navigation";
import { currentUser, signInPath } from "@/auth";
import { canViewMembers } from "@/lib/members-guard";
import MembersDirectory from "@/components/MembersDirectory";

export const dynamic = "force-dynamic";

/**
 * The Members page — the roster/administration surface that used to be
 * scattered across the vouch screen (attested list + role controls), the
 * admin dashboard, and the profile's allowlist panel. Gated like Budget
 * Categories and Positions (treasurer/admin); a caller who may not view it is
 * bounced home as if the page didn't exist (the API returns 404), never a
 * visible 403.
 */
export default async function MembersPage() {
  const user = await currentUser();
  if (!user) redirect(signInPath("/members"));
  if (!canViewMembers(user)) redirect("/");
  return <MembersDirectory />;
}
