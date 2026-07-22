import { redirect } from "next/navigation";
import { currentUser, signInPath } from "@/auth";
import { canManageOrg } from "@/lib/manage-guard";
import ManageHub from "@/components/ManageHub";

export const dynamic = "force-dynamic";

/**
 * The organization-administration hub — a role-scoped launcher for Budget
 * categories, Positions, Teams, Members, Proposed changes, and Admin (moved out
 * of the account menu). Gated like every privileged surface: a caller who can
 * reach none of the tools is bounced home as if the page didn't exist (each
 * destination and its API keep their own 404 guards — CLAUDE.md invariant #2).
 */
export default async function ManagePage() {
  const user = await currentUser();
  if (!user) redirect(signInPath("/manage"));
  if (!canManageOrg(user)) redirect("/");
  return <ManageHub />;
}
