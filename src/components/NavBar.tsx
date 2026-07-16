"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
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

function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
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

  // Tabs the row reduced — compressed to icons or overflowed out — which the
  // account menu also lists (with labels). `overflow` is the hidden subset,
  // whose badges aggregate onto the avatar.
  const [nav, setNav] = useState<{ menu: string[]; overflow: string[] }>({ menu: [], overflow: [] });
  const onMenuChange = useCallback((menu: string[], overflow: string[]) => {
    setNav((prev) =>
      sameArray(prev.menu, menu) && sameArray(prev.overflow, overflow) ? prev : { menu, overflow }
    );
  }, []);

  // Receipts + Claims keep their labels and never collapse (pinned + keepLabel).
  // The role tabs compress to icons, then collapse into the account menu, lowest
  // priority first; a work badge outranks all of it (see nav-overflow.ts).
  const links: NavLink[] = [
    { href: "/", label: t("shoebox"), icon: <ReceiptsIcon />, priority: 100, pinned: true, keepLabel: true },
    { href: "/claims", label: t("claims"), icon: <ClaimsIcon />, priority: 90, pinned: true, keepLabel: true },
  ];
  if (badges.enabled && (badges.approvals ?? 0) > 0) {
    links.push({ href: "/approvals", label: t("approvals"), icon: <ApprovalsIcon />, badge: badges.approvals, priority: 80 });
  } else if (badges.enabled && ["approver", "treasurer", "admin"].includes(badges.role ?? "")) {
    links.push({ href: "/approvals", label: t("approvals"), icon: <ApprovalsIcon />, priority: 80 });
  }
  if (badges.enabled && badges.finance !== null && badges.finance !== undefined) {
    links.push({ href: "/finance", label: t("finance"), icon: <FinanceIcon />, badge: badges.finance || undefined, priority: 70 });
  }

  const overflowSet = new Set(nav.overflow);
  const menuTabs = nav.menu
    .map((href) => links.find((l) => l.href === href))
    .filter((l): l is NavLink => !!l)
    .map((l) => ({ ...l, hidden: overflowSet.has(l.href) }));

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
          <NavTabs links={links} onMenuChange={onMenuChange} />
        </nav>
        <AccountMenu userName={userName} isAdmin={isAdmin} menuTabs={menuTabs} />
      </div>
    </header>
  );
}
