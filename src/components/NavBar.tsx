"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import AccountMenu from "./AccountMenu";
import NavTabs, { type NavLink } from "./NavTabs";
import { ApprovalsIcon, ClaimsIcon, FinanceIcon, ReceiptsIcon } from "./nav-icons";

interface Badges {
  enabled: boolean;
  role?: string;
  approvals?: number;
  finance?: number | null;
}

export default function NavBar({ userName, isAdmin }: { userName: string; isAdmin?: boolean }) {
  const pathname = usePathname();
  const t = useTranslations("NavBar");
  // E-sign work badges (no notification infra — the nav surfaces state).
  const [badges, setBadges] = useState<Badges>({ enabled: false });
  useEffect(() => {
    void fetch("/api/esign/badges")
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then(setBadges)
      .catch(() => {});
  }, [pathname]);

  // Priority sets the collapse order when room runs out (lower collapses first);
  // a badge outranks all of it, and the home tab is pinned (see NavTabs).
  const links: NavLink[] = [
    { href: "/", label: t("shoebox"), icon: <ReceiptsIcon />, priority: 100, pinned: true },
    { href: "/claims", label: t("claims"), icon: <ClaimsIcon />, priority: 90 },
  ];
  if (badges.enabled && (badges.approvals ?? 0) > 0) {
    links.push({ href: "/approvals", label: t("approvals"), icon: <ApprovalsIcon />, badge: badges.approvals, priority: 80 });
  } else if (badges.enabled && ["approver", "treasurer", "admin"].includes(badges.role ?? "")) {
    links.push({ href: "/approvals", label: t("approvals"), icon: <ApprovalsIcon />, priority: 80 });
  }
  if (badges.enabled && badges.finance !== null && badges.finance !== undefined) {
    links.push({ href: "/finance", label: t("finance"), icon: <FinanceIcon />, badge: badges.finance || undefined, priority: 70 });
  }
  // Profile, language, Admin and sign out live in the AccountMenu, so the tab
  // row stays functional-only. Admin's page + API still 404 for anyone
  // unauthorized regardless.

  return (
    <header className="sticky top-0 z-40 border-b border-stone-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-3 py-3 sm:px-4">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-1.5 text-lg font-bold text-indigo-700"
          aria-label="Numbers"
        >
          <span aria-hidden>⛪</span> <span className="hidden sm:inline">Numbers</span>
        </Link>
        <nav className="flex min-w-0 flex-1 items-center" aria-label="Main">
          <NavTabs links={links} />
        </nav>
        <AccountMenu userName={userName} isAdmin={isAdmin} />
      </div>
    </header>
  );
}
