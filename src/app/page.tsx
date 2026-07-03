import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUserId } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  const [unassigned, drafts, generated, user] = await Promise.all([
    prisma.receipt.count({ where: { userId, status: "unassigned" } }),
    prisma.reimbursement.count({ where: { userId, status: "draft" } }),
    prisma.reimbursement.findMany({
      where: { userId, status: "generated" },
      orderBy: { createdAt: "desc" },
      take: 3,
    }),
    prisma.user.findUnique({ where: { id: userId }, select: { fullName: true, mailingAddress: true } }),
  ]);

  const profileIncomplete = !user?.fullName || !user?.mailingAddress;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Welcome back</h1>

      {profileIncomplete && (
        <div className="card border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" data-testid="profile-nudge">
          Your <Link href="/profile" className="font-semibold underline">profile</Link> is missing a name or
          mailing address — both get printed on the reimbursement form.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Link href="/shoebox" className="card block p-6 hover:border-indigo-300" data-testid="stat-shoebox">
          <div className="text-3xl font-bold text-indigo-700">{unassigned}</div>
          <div className="mt-1 text-sm text-stone-500">receipts in your Shoebox</div>
        </Link>
        <Link href="/claims" className="card block p-6 hover:border-indigo-300" data-testid="stat-drafts">
          <div className="text-3xl font-bold text-indigo-700">{drafts}</div>
          <div className="mt-1 text-sm text-stone-500">draft claims in review</div>
        </Link>
        <div className="card p-6">
          <div className="text-3xl font-bold text-emerald-700">{generated.length > 0 ? formatCents(generated[0].totalCents) : "—"}</div>
          <div className="mt-1 text-sm text-stone-500">last generated claim</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link href="/shoebox" className="btn-primary px-6 py-3 text-base">
          📷 Upload Receipt
        </Link>
        <Link href="/shoebox" className="btn-secondary px-6 py-3 text-base">
          🧾 Start a Claim
        </Link>
      </div>

      <div className="card p-6">
        <h2 className="font-semibold">How it works</h2>
        <ol className="mt-3 grid gap-3 text-sm text-stone-600 sm:grid-cols-4">
          <li><span className="font-semibold text-indigo-700">1. Snap.</span> Photograph receipts into your Shoebox the moment you buy.</li>
          <li><span className="font-semibold text-indigo-700">2. Batch.</span> Once a month, select receipts and generate a claim — AI drafts the line items.</li>
          <li><span className="font-semibold text-indigo-700">3. Verify.</span> Check every row against the receipt. Fix, split, or exclude items.</li>
          <li><span className="font-semibold text-indigo-700">4. Print.</span> Download the filled CFCC form with receipts attached, sign, and drop it off.</li>
        </ol>
      </div>
    </div>
  );
}
