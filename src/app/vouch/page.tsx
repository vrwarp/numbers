import { redirect } from "next/navigation";
import { currentUserId } from "@/auth";
import VouchScreen from "@/components/esign/VouchScreen";

export const dynamic = "force-dynamic";

/** In-person vouching (docs/ESIGN_DESIGN.md §4.3). The candidate's QR
 *  encodes this URL with their identity in `c`, so a voucher lands here by
 *  scanning it with their phone camera. */
export default async function VouchPage() {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");
  return <VouchScreen />;
}
