"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import LocaleSwitcher from "./LocaleSwitcher";
import { signOut } from "@/lib/sign-out";

/**
 * The account cluster, lifted out of the tab row so the role-gated tabs
 * (Approvals, Finance) fit a phone width without horizontal scroll. Holds the
 * low-frequency items — Profile, language, Admin, sign out — behind one
 * top-right control. Lives OUTSIDE the nav's overflow-x container so its
 * dropdown isn't clipped, and is the only place a phone can sign out (the old
 * inline button was sm:block, i.e. desktop-only).
 */
export default function AccountMenu({ userName, isAdmin }: { userName: string; isAdmin?: boolean }) {
  const t = useTranslations("NavBar");
  const tc = useTranslations("Common");
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
  const itemClass =
    "block w-full rounded-lg px-2.5 py-2 text-left text-sm text-stone-700 hover:bg-stone-100";

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t("account")}
        data-testid="account-menu"
        className="flex items-center gap-1 rounded-full border border-stone-200 bg-white py-1 pl-1 pr-2 text-stone-600 hover:bg-stone-100"
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
      </button>
      {open ? (
        // A disclosure dropdown of plain links, not an ARIA menu — no arrow-key
        // contract to honor, and links keep their native semantics.
        <div
          aria-label={t("account")}
          className="absolute right-0 top-full z-50 mt-1.5 w-56 rounded-xl border border-stone-200 bg-white p-1.5 shadow-lg"
        >
          <p className="truncate px-2.5 py-1.5 text-xs text-stone-400">
            {t("signedInAs", { name: userName })}
          </p>
          <Link href="/profile" className={itemClass}>
            {t("profile")}
          </Link>
          <div className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm text-stone-700">
            <span>{tc("language")}</span>
            <LocaleSwitcher signedIn variant="compact" />
          </div>
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
