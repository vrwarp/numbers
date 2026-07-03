import { redirect } from "next/navigation";
import { currentUserId } from "@/auth";
import ProfileForm from "@/components/ProfileForm";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");
  return <ProfileForm />;
}
