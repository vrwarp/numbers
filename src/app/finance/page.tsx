import { redirect } from "next/navigation";
import { currentUserId, signInPath } from "@/auth";
import FinanceQueue from "@/components/esign/FinanceQueue";

export const dynamic = "force-dynamic";

export default async function FinancePage() {
  const userId = await currentUserId();
  if (!userId) redirect(signInPath("/finance"));
  return <FinanceQueue />;
}
