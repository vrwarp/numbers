import VerificationView from "@/components/esign/VerificationView";

export const dynamic = "force-dynamic";

/**
 * Public verification page (docs/ESIGN_DESIGN.md §7.2) — the audit tool the
 * certificate QR points at. All verification happens client-side from the
 * token-authorized API; SQLite status never feeds the verdict.
 */
export default async function VerifyPage(ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  return <VerificationView token={token} />;
}
