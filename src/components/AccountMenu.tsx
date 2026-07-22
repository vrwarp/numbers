"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import LocaleSwitcher from "./LocaleSwitcher";
import { navBadgeId, navTestId, type NavLink } from "./NavTabs";
import { signOut } from "@/lib/sign-out";
import { openFeedback } from "@/lib/feedback/open";

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
  canViewMembers,
  canManageTeams,
  menuTabs = [],
  esignSetup = null,
}: {
  userName: string;
  isAdmin?: boolean;
  canManageMinistries?: boolean;
  canViewMembers?: boolean;
  canManageTeams?: boolean;
  menuTabs?: Array<NavLink & { hidden?: boolean }>;
  /** EP7 (docs/ESIGN_SETUP_DISCOVERABILITY.md §3.3): the persistent e-sign
   *  setup door. A menu row, not a banner — never dismissible, never feeds the
   *  avatar work-dot (that dot means pending WORK). chip null = the user opted
   *  for paper or is revoked: the door stays, the to-do valence goes. */
  esignSetup?: { kind: "setup" | "qr"; chip: "none" | "pending" | null } | null;
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
  // Section headers give the flat list seams so the org-management cluster reads
  // as its own group, not peers of Profile. Rendered only when the group has ≥1
  // visible row (the Manage items are each role-gated).
  const sectionClass = "px-2.5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-stone-400";
  const hasManage = canManageMinistries || canManageTeams || canViewMembers || isAdmin;
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
          {esignSetup ? (
            // Label stays one line; the status chip sits on its own line below
            // so a long chip can never clip at the popover edge. Pending chip
            // is indigo (progress), never amber — being further along must not
            // read as escalation.
            <Link
              href="/profile?open=esign"
              className="flex flex-col items-start gap-1 rounded-lg px-2.5 py-2 text-sm text-stone-700 hover:bg-stone-100"
              data-testid="nav-esign-setup"
            >
              <span className="flex items-center gap-2 whitespace-nowrap">
                <span aria-hidden>✍️</span>
                {esignSetup.kind === "qr" ? t("showYourCode") : t("setupSigning")}
              </span>
              {esignSetup.chip ? (
                <span
                  className={`ml-6 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    esignSetup.chip === "pending"
                      ? "bg-indigo-50 text-indigo-700"
                      : "bg-stone-100 text-stone-600"
                  }`}
                >
                  {esignSetup.chip === "pending" ? t("chipPending") : t("chipNone")}
                </span>
              ) : null}
            </Link>
          ) : null}
          <p className={sectionClass}>{t("account")}</p>
          <Link href="/profile" className={itemClass}>
            {t("profile")}
          </Link>
          {/* §5 activity parity entry point — its own page, no unread counts
              by design (docs/NOTIFICATIONS_DESIGN.md §2 no read-tracking). */}
          <Link
            href="/activity"
            className={`${itemClass} ${isActive("/activity") ? "bg-indigo-50 text-indigo-700" : ""}`}
            data-testid="nav-activity"
          >
            {t("recentActivity")}
          </Link>
          <LocaleSwitcher signedIn variant="row" />
          {hasManage ? <p className={sectionClass}>{t("manage")}</p> : null}
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
          {canManageTeams ? (
            <Link href="/teams" className={itemClass} data-testid="nav-teams">
              {t("teams")}
            </Link>
          ) : null}
          {canViewMembers ? (
            <Link href="/members" className={itemClass} data-testid="nav-members">
              {t("members")}
            </Link>
          ) : null}
          {canManageMinistries || canManageTeams ? (
            // Where catalog edits an AI assistant staged (MCP) are applied.
            <Link href="/catalog-drafts" className={itemClass} data-testid="nav-catalog-drafts">
              {t("proposedChanges")}
            </Link>
          ) : null}
          {isAdmin ? (
            <Link href="/admin" className={itemClass}>
              {t("admin")}
            </Link>
          ) : null}
          <div className="my-1 h-px bg-stone-100" />
          {/* Feedback / bug report — the primary, discoverable entry point
              (docs/FEEDBACK_DESIGN.md). No floating button: it would collide
              with the claim's sticky action bar. */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              openFeedback();
            }}
            className={itemClass}
            data-testid="nav-feedback"
          >
            {t("reportProblem")}
          </button>
          <button type="button" onClick={() => signOut()} className={itemClass}>
            {t("signOut")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
