"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import LocaleSwitcher from "./LocaleSwitcher";
import { navBadgeId, navTestId, type NavLink } from "./NavTabs";
import { signOut } from "@/lib/sign-out";

/**
 * The account cluster — Profile, language, Admin, sign out — behind one
 * top-right control, so the tab row stays functional-only and fits a phone even
 * for a treasurer or admin. It is ALSO where reduced nav tabs are listed
 * (menuTabs): both tabs compressed to icons in the row AND tabs overflowed out
 * of it, each with its label — one dropdown, not two, and always a labeled way
 * to reach an icon-only tab. A tab that is `hidden` (overflowed, not in the row)
 * and badged lights an aggregated dot on the avatar so a pending-work signal is
 * never lost. Lives outside the nav's overflow container so its panel isn't
 * clipped, and is the only place a phone can sign out.
 */
export default function AccountMenu({
  userName,
  isAdmin,
  canManageMinistries,
  menuTabs = [],
}: {
  userName: string;
  isAdmin?: boolean;
  canManageMinistries?: boolean;
  menuTabs?: Array<NavLink & { hidden?: boolean }>;
}) {
  const t = useTranslations("NavBar");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initial = (userName.trim()[0] ?? "?").toUpperCase();
  // Only tabs hidden from the row aggregate onto the avatar — a compressed tab's
  // badge is still visible on its icon in the row.
  const overflowBadge = menuTabs.some((l) => l.hidden && l.badge);
  const itemClass =
    "block w-full rounded-lg px-2.5 py-2 text-left text-sm text-stone-700 hover:bg-stone-100";
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t("account")}
        data-testid="account-menu"
        className="relative flex items-center gap-1 rounded-full border border-stone-200 bg-white py-1 pl-1 pr-2 text-stone-600 hover:bg-stone-100"
      >
        <span
          aria-hidden
          className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white"
        >
          {initial}
        </span>
        <span aria-hidden className="text-[10px] text-stone-400">
          ▾
        </span>
        {overflowBadge ? (
          <span
            className="absolute right-1 top-0.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white"
            data-testid="badge-account"
          >
            <span className="sr-only">{t("pendingWork")}</span>
          </span>
        ) : null}
      </button>
      {open ? (
        // A disclosure dropdown of plain links, not an ARIA menu — no arrow-key
        // contract to honor, and links keep their native semantics.
        <div
          aria-label={t("account")}
          data-testid="account-menu-panel"
          className="absolute right-0 top-full z-50 mt-1.5 w-56 rounded-xl border border-stone-200 bg-white p-1.5 shadow-lg"
        >
          <p className="truncate px-2.5 py-1.5 text-xs text-stone-400">
            {t("signedInAs", { name: userName })}
          </p>
          {menuTabs.length > 0 ? (
            <>
              {menuTabs.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  data-testid={navTestId(l.href)}
                  className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-sm ${
                    isActive(l.href) ? "bg-indigo-50 text-indigo-700" : "text-stone-700 hover:bg-stone-100"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span aria-hidden>{l.icon}</span>
                    {l.label}
                  </span>
                  {l.badge ? (
                    <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" data-testid={navBadgeId(l.href)}>
                      <span className="sr-only">{t("pendingWork")}</span>
                    </span>
                  ) : null}
                </Link>
              ))}
              <div className="my-1 h-px bg-stone-100" />
            </>
          ) : null}
          <Link href="/profile" className={itemClass}>
            {t("profile")}
          </Link>
          <LocaleSwitcher signedIn variant="row" />
          {canManageMinistries ? (
            <Link href="/ministries" className={itemClass} data-testid="nav-budget-categories">
              {t("budgetCategories")}
            </Link>
          ) : null}
          {canManageMinistries ? (
            <Link href="/positions" className={itemClass} data-testid="nav-positions">
              {t("positions")}
            </Link>
          ) : null}
          {canManageMinistries ? (
            <Link href="/members" className={itemClass} data-testid="nav-members">
              {t("members")}
            </Link>
          ) : null}
          {isAdmin ? (
            <Link href="/admin" className={itemClass}>
              {t("admin")}
            </Link>
          ) : null}
          <div className="my-1 h-px bg-stone-100" />
          <button type="button" onClick={() => signOut()} className={itemClass}>
            {t("signOut")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
