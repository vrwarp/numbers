import { redirect } from "next/navigation";
import { currentUserId, signInPath } from "@/auth";
import ApprovalsInbox from "@/components/esign/ApprovalsInbox";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const userId = await currentUserId();
  if (!userId) redirect(signInPath("/approvals"));
  return <ApprovalsInbox />;
}
