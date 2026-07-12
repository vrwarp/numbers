import { redirect } from "next/navigation";
import { currentUserId } from "@/auth";
import VouchScreen from "@/components/esign/VouchScreen";

export const dynamic = "force-dynamic";

/** In-person vouching (docs/ESIGN_DESIGN.md §4.3). The candidate's QR
 *  encodes this URL with their identity in `c`. A voucher either scans it
 *  in-page here (VouchQrScanner, no `c`) or lands here directly because their
 *  phone's camera app opened the encoded link. */
export default async function VouchPage() {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");
  return <VouchScreen />;
}
