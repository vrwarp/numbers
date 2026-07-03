import { redirect } from "next/navigation";
import { currentUserId } from "@/auth";
import ReviewClaim from "@/components/ReviewClaim";

export const dynamic = "force-dynamic";

export default async function ClaimDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");
  const { id } = await params;
  return <ReviewClaim claimId={id} />;
}
