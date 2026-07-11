import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUserId } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/money";

export const dynamic = "force-dynamic";

// Full e-sign workflow chip set (docs/ESIGN_DESIGN.md §6.1).
const STATUS_STYLES: Record<string, string> = {
  draft: "bg-amber-100 text-amber-800",
  generated: "bg-emerald-100 text-emerald-800",
  submitted: "bg-sky-100 text-sky-800",
  rejected: "bg-red-100 text-red-800",
  approved: "bg-emerald-100 text-emerald-800",
  paid: "bg-indigo-100 text-indigo-800",
};
const STATUS_LABELS: Record<string, string> = {
  draft: "Needs review",
  generated: "Generated",
  submitted: "Awaiting approval",
  rejected: "Rejected",
  approved: "Approved",
  paid: "Paid",
};

export default async function ClaimsPage() {
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  const claims = await prisma.reimbursement.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { lineItems: true, receipts: true } } },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Claims</h1>
        <p className="text-sm text-stone-500">Draft claims need review; generated claims are ready to print and sign.</p>
      </div>

      {claims.length === 0 ? (
        <div className="card p-10 text-center text-stone-500">
          <div className="text-4xl">🧾</div>
          <p className="mt-2 font-medium">No claims yet</p>
          <p className="text-sm">
            Select receipts in your <Link href="/" className="text-indigo-600 underline">Shoebox</Link> and
            hit &ldquo;New Claim&rdquo;.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {claims.map((c) => (
            <li key={c.id}>
              <Link href={`/claims/${c.id}`} className="card flex items-center justify-between p-4 hover:border-indigo-300" data-testid={`claim-${c.id}`}>
                <div>
                  <div className="font-semibold">
                    {new Date(c.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
                  </div>
                  <div className="text-sm text-stone-500">
                    {c._count.lineItems} items · {c._count.receipts} receipt{c._count.receipts === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-lg font-bold">{formatCents(c.totalCents)}</span>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLES[c.status] ?? STATUS_STYLES.generated}`}
                  >
                    {STATUS_LABELS[c.status] ?? c.status}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
