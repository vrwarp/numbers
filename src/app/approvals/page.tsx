import { redirect } from "next/navigation";
import { currentUserId } from "@/auth";
import ApprovalsInbox from "@/components/esign/ApprovalsInbox";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");
  return <ApprovalsInbox />;
}
