import { redirect } from "next/navigation";
import { currentUserId, signInPath } from "@/auth";
import { prisma } from "@/lib/prisma";
import ReviewClaim from "@/components/ReviewClaim";

export const dynamic = "force-dynamic";

export default async function ClaimDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const userId = await currentUserId();
  const { id } = await params;
  if (!userId) redirect(signInPath(`/claims/${id}`));
  // The PDF gate refuses a blank payee (name/address print on the form), so
  // the review screen needs to know up front whether to surface the fix-it
  // banner instead of a dead disabled button.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { fullName: true, mailingAddress: true },
  });
  const profileComplete = !!user?.fullName?.trim() && !!user?.mailingAddress?.trim();
  return <ReviewClaim claimId={id} profileComplete={profileComplete} />;
}
