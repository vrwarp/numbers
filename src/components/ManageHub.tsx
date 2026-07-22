import Link from "next/link";
import type { ReactNode, SVGProps } from "react";
import { getTranslations } from "next-intl/server";
import { currentUser } from "@/auth";
import { isAppAdmin } from "@/lib/config";
import { canManageMinistries } from "@/lib/ministries-guard";
import { canManageTeams } from "@/lib/teams-guard";
import { canViewMembers } from "@/lib/members-guard";

function CardIcon({ children }: { children: ReactNode } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 text-indigo-600"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/**
 * The /manage hub — a role-scoped launcher for the organization-administration
 * tools that used to live as a flat cluster in the account menu. Each card is
 * shown only when its own gate passes (the same gate the destination page and
 * its API enforce — this hub is a launcher, not a security boundary; see
 * src/lib/manage-guard.ts). A server component so the gates run server-side and
 * never ship a card the user can't use.
 */
export default async function ManageHub() {
  const user = await currentUser();
  if (!user) return null; // the /manage route already redirects; belt & suspenders

  const [t, tn] = await Promise.all([getTranslations("Manage"), getTranslations("NavBar")]);

  const cards: Array<{
    show: boolean;
    href: string;
    testId: string;
    title: string;
    desc: string;
    icon: ReactNode;
  }> = [
    {
      show: canManageMinistries(user),
      href: "/ministries",
      testId: "manage-budget-categories",
      title: tn("budgetCategories"),
      desc: t("budgetCategoriesDesc"),
      icon: (
        <CardIcon>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </CardIcon>
      ),
    },
    {
      show: canManageMinistries(user),
      href: "/positions",
      testId: "manage-positions",
      title: tn("positions"),
      desc: t("positionsDesc"),
      icon: (
        <CardIcon>
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <circle cx="12" cy="10" r="2.5" />
          <path d="M8 17c1-2 7-2 8 0" />
        </CardIcon>
      ),
    },
    {
      show: canManageTeams(user),
      href: "/teams",
      testId: "manage-teams",
      title: tn("teams"),
      desc: t("teamsDesc"),
      icon: (
        <CardIcon>
          <circle cx="9" cy="9" r="3" />
          <path d="M3 20c0-3 3-5 6-5s6 2 6 5" />
          <path d="M16 6a3 3 0 0 1 0 6M21 20c0-2-1.5-3.5-3.5-4.2" />
        </CardIcon>
      ),
    },
    {
      show: canViewMembers(user),
      href: "/members",
      testId: "manage-members",
      title: tn("members"),
      desc: t("membersDesc"),
      icon: (
        <CardIcon>
          <circle cx="9" cy="8" r="3" />
          <circle cx="17" cy="9" r="2.4" />
          <path d="M3 20c0-3 3-5 6-5s6 2 6 5M15 20c0-2 .5-3 2-3.6" />
        </CardIcon>
      ),
    },
    {
      show: canManageMinistries(user) || canManageTeams(user),
      href: "/catalog-drafts",
      testId: "manage-catalog-drafts",
      title: tn("proposedChanges"),
      desc: t("proposedChangesDesc"),
      icon: (
        <CardIcon>
          <path d="M12 4v16M6 8H4M8 8H6M4 16h4M18 4l3 3-3 3M16 7h5" />
        </CardIcon>
      ),
    },
    {
      show: isAppAdmin(user),
      href: "/admin",
      testId: "manage-admin",
      title: tn("admin"),
      desc: t("adminDesc"),
      icon: (
        <CardIcon>
          <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
          <path d="m9 12 2 2 4-4" />
        </CardIcon>
      ),
    },
  ];

  const visible = cards.filter((c) => c.show);

  return (
    <div data-testid="manage-hub">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p className="mt-1 text-sm text-stone-500">{t("subtitle")}</p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            data-testid={c.testId}
            className="card card-lift pressable block p-4"
          >
            <span className="mb-2 block">{c.icon}</span>
            <span className="block font-semibold text-stone-900">{c.title}</span>
            <span className="mt-0.5 block text-sm text-stone-500">{c.desc}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
