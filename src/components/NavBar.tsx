"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import LocaleSwitcher from "./LocaleSwitcher";
import { signOut } from "@/lib/sign-out";

interface Badges {
  enabled: boolean;
  role?: string;
  approvals?: number;
  finance?: number | null;
}

export default function NavBar({ userName }: { userName: string }) {
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

  const links: { href: string; label: string; badge?: number }[] = [
    { href: "/", label: t("shoebox") },
    { href: "/claims", label: t("claims") },
  ];
  if (badges.enabled && (badges.approvals ?? 0) > 0) {
    links.push({ href: "/approvals", label: t("approvals"), badge: badges.approvals });
  } else if (badges.enabled && ["approver", "treasurer", "admin"].includes(badges.role ?? "")) {
    links.push({ href: "/approvals", label: t("approvals") });
  }
  if (badges.enabled && badges.finance !== null && badges.finance !== undefined) {
    links.push({ href: "/finance", label: t("finance"), badge: badges.finance || undefined });
  }
  links.push({ href: "/profile", label: t("profile") });


  return (
    <header className="sticky top-0 z-40 border-b border-stone-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-3 py-3 sm:px-4">
        <Link href="/" className="flex shrink-0 items-center gap-1.5 text-lg font-bold text-indigo-700">
          <span aria-hidden>⛪</span> <span className="hidden sm:inline">Numbers</span>
        </Link>
        <nav className="flex min-w-0 items-center gap-0.5 overflow-x-auto sm:gap-2" aria-label="Main">
          {links.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`relative whitespace-nowrap rounded-lg px-2 py-1.5 text-sm font-medium sm:px-3 ${
                  active ? "bg-indigo-50 text-indigo-700" : "text-stone-600 hover:bg-stone-100"
                }`}
              >
                {l.label}
                {l.badge ? (
                  <span
                    className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white"
                    data-testid={`badge-${l.href.slice(1) || "shoebox"}`}
                  >
                    {l.badge}
                  </span>
                ) : null}
              </Link>
            );
          })}
          <LocaleSwitcher signedIn variant="compact" className="ml-1" />
          <button
            onClick={() => signOut()}
            className="ml-1 hidden rounded-lg px-3 py-1.5 text-sm text-stone-500 hover:bg-stone-100 sm:block"
            title={t("signedInAs", { name: userName })}
          >
            {t("signOut")}
          </button>
        </nav>
      </div>
    </header>
  );
}
