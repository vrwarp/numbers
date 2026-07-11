import { redirect } from "next/navigation";
import { currentUserId } from "@/auth";
import ProfileForm from "@/components/ProfileForm";
import SigningIdentityCard from "@/components/esign/SigningIdentityCard";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");
  return (
    <div className="space-y-6">
      <ProfileForm />
      <SigningIdentityCard />
    </div>
  );
}
