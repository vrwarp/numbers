"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAutoRefresh } from "@/lib/use-auto-refresh";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import AccountMenu from "./AccountMenu";
import CanaryBadge from "./CanaryBadge";
import NavTabs, { type NavLink } from "./NavTabs";
import { ApprovalsIcon, ClaimsIcon, FinanceIcon, ManageIcon, ReceiptsIcon, SearchIcon, VouchIcon } from "./nav-icons";
import { APPROVER_PLUS_ROLES } from "@/lib/esign/types";

interface Badges {
  enabled: boolean;
  role?: string;
  approvals?: number;
  approvalsPaused?: boolean;
  finance?: number | null;
  vouch?: boolean;
  /** EP7 wayfinding row for the account menu (null = attested / ineligible). */
  setup?: { kind: "setup" | "qr"; chip: "none" | "pending" | null } | null;
}

function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export default function NavBar({
  userName,
  isAdmin,
  canManageMinistries,
  canViewMembers,
  canManageTeams,
  searchEnabled,
  canary,
}: {
  userName: string;
  isAdmin?: boolean;
  canManageMinistries?: boolean;
  canViewMembers?: boolean;
  canManageTeams?: boolean;
  searchEnabled?: boolean;
  canary?: boolean;
}) {
  const pathname = usePathname();
  const t = useTranslations("NavBar");
  // E-sign work badges (no notification infra — the nav surfaces state).
  // Refreshed on navigation AND on a visible-tab interval: with no push
  // notifications anywhere, this badge is the ONLY way an approver parked on
  // another page learns that work arrived.
  const [badges, setBadges] = useState<Badges>({ enabled: false });
  const loadBadges = useCallback(() => {
    void fetch("/api/esign/badges")
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then(setBadges)
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadBadges();
  }, [loadBadges, pathname]);
  useAutoRefresh(loadBadges, { intervalMs: 90_000 });

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
  // Declared placement (SEARCH_DESIGN §7.1): labeled on desktop, compresses to
  // an icon on narrow widths, pinned so it never vanishes into the overflow —
  // the inline pills on Receipts/Claims are the primary mobile path anyway.
  if (searchEnabled) {
    links.push({ href: "/search", label: t("search"), icon: <SearchIcon />, priority: 85, pinned: true });
  }
  // Claims already assigned keep the tab (with its badge) even while the
  // member has paused approvals (A10) — pausing stops new submissions, not
  // the ones waiting on them. Paused + nothing pending ⇒ no tab.
  if (badges.enabled && (badges.approvals ?? 0) > 0) {
    links.push({ href: "/approvals", label: t("approvals"), icon: <ApprovalsIcon />, badge: badges.approvals, priority: 80 });
  } else if (
    badges.enabled &&
    (APPROVER_PLUS_ROLES as readonly string[]).includes(badges.role ?? "") &&
    !badges.approvalsPaused
  ) {
    links.push({ href: "/approvals", label: t("approvals"), icon: <ApprovalsIcon />, priority: 80 });
  }
  if (badges.enabled && badges.finance !== null && badges.finance !== undefined) {
    links.push({ href: "/finance", label: t("finance"), icon: <FinanceIcon />, badge: badges.finance || undefined, priority: 70 });
  }
  // Attested members vouch for candidates in person — a full tab, but the
  // least urgent one, so it compresses/overflows first.
  if (badges.enabled && badges.vouch) {
    links.push({ href: "/vouch", label: t("vouch"), icon: <VouchIcon />, priority: 60 });
  }
  // Organization administration (Budget categories, Positions, Teams, Members,
  // Proposed changes, Admin) lives behind one entry now. On desktop it's this
  // tab → /manage; on narrow widths it overflows into the account menu as a
  // labeled "Manage" row (same menuTabs mechanism), so both breakpoints get a
  // single, discoverable entry point. Lowest priority + not pinned: it's the
  // first tab to give up its spot when the row is tight. The gate is the union
  // of the per-tool guards (src/lib/manage-guard.ts), mirrored from the flags
  // layout already computed.
  const showManage = isAdmin || canManageMinistries || canViewMembers || canManageTeams;
  if (showManage) {
    links.push({ href: "/manage", label: t("manage"), icon: <ManageIcon />, priority: 50 });
  }

  const overflowSet = new Set(nav.overflow);
  const menuTabs = nav.menu
    .map((href) => links.find((l) => l.href === href))
    .filter((l): l is NavLink => !!l)
    .map((l) => ({ ...l, hidden: overflowSet.has(l.href) }));

  return (
    <header className="sticky top-0 z-40 border-b border-stone-200 bg-white/90 pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur short-wide:static">
      <div className="keyboard-smooth mx-auto flex max-w-6xl items-center gap-2 px-3 py-3 short-wide:py-1.5 sm:px-4">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-1.5 text-lg font-bold text-indigo-700"
          aria-label="Numbers"
        >
          <span aria-hidden>⛪</span> <span className="hidden sm:inline">Numbers</span>
          {canary && <CanaryBadge />}
        </Link>
        <nav className="flex min-w-0 flex-1 items-center" aria-label="Main">
          <NavTabs links={links} onMenuChange={onMenuChange} />
        </nav>
        <AccountMenu
          userName={userName}
          menuTabs={menuTabs}
          esignSetup={badges.enabled ? (badges.setup ?? null) : null}
        />
      </div>
    </header>
  );
}
