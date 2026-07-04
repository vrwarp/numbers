import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUserId } from "@/auth";
import { prisma } from "@/lib/prisma";
import Shoebox from "@/components/Shoebox";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { fullName: true, mailingAddress: true },
  });
  const profileIncomplete = !user?.fullName || !user?.mailingAddress;

  return (
    <div className="space-y-6">
      {profileIncomplete && (
        <div className="card border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" data-testid="profile-nudge">
          Your <Link href="/profile" className="font-semibold underline">profile</Link> is missing a name or
          mailing address — both get printed on the reimbursement form.
        </div>
      )}
      <Shoebox />
    </div>
  );
}
