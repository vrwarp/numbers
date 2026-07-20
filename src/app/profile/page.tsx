import { redirect } from "next/navigation";
import { currentUserId, signInPath } from "@/auth";
import { pushWebConfig } from "@/lib/notifications/settings";
import ProfileForm, { MobileSignOut } from "@/components/ProfileForm";
import SigningIdentityCard from "@/components/esign/SigningIdentityCard";
import NotificationsCard from "@/components/notifications/NotificationsCard";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const userId = await currentUserId();
  if (!userId) redirect(signInPath("/profile"));
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <ProfileForm />
      <NotificationsCard pushConfig={pushWebConfig()} />
      <SigningIdentityCard />
      <MobileSignOut />
    </div>
  );
}
