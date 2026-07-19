import { redirect } from "next/navigation";
import { currentUserId } from "@/auth";
import VouchScreen from "@/components/esign/VouchScreen";

export const dynamic = "force-dynamic";

/** In-person vouching (docs/ESIGN_DESIGN.md §4.3). The candidate's QR
 *  encodes this URL with their identity in `c`. A voucher either scans it
 *  in-page here (VouchQrScanner, no `c`) or lands here directly because their
 *  phone's camera app opened the encoded link. */
export default async function VouchPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const userId = await currentUserId();
  if (!userId) {
    // A voucher who scanned the candidate's QR with their CAMERA APP lands
    // here logged out — losing `c` at sign-in destroys the whole in-person
    // ceremony. Carry the payload through as the post-login destination.
    const { c } = await searchParams;
    redirect(
      c ? `/signin?return=${encodeURIComponent(`/vouch?c=${encodeURIComponent(c)}`)}` : "/signin"
    );
  }
  return <VouchScreen />;
}
