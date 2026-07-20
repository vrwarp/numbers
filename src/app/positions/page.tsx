import { redirect } from "next/navigation";
import { currentUser, signInPath } from "@/auth";
import { canManagePositions } from "@/lib/positions-guard";
import Positions from "@/components/Positions";

export const dynamic = "force-dynamic";

/**
 * Treasurer's Positions editor (custom approval roles). Gated like every
 * privileged surface — the same treasurer/admin gate as Budget Categories — so
 * a caller who may not manage them is bounced home as if the page didn't exist
 * (the API returns 404), never a visible 403.
 */
export default async function PositionsPage() {
  const user = await currentUser();
  if (!user) redirect(signInPath("/positions"));
  if (!canManagePositions(user)) redirect("/");
  return <Positions />;
}
