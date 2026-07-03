import { redirect } from "next/navigation";
import { currentUserId } from "@/auth";
import Shoebox from "@/components/Shoebox";

export const dynamic = "force-dynamic";

export default async function ShoeboxPage() {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");
  return <Shoebox />;
}
