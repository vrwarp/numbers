"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

async function signOut() {
  await fetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
  window.location.assign("/signin");
}

const LINKS = [
  { href: "/", label: "Shoebox" },
  { href: "/claims", label: "Claims" },
  { href: "/profile", label: "Profile" },
];

export default function NavBar({ userName }: { userName: string }) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-stone-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-3 py-3 sm:px-4">
        <Link href="/" className="flex shrink-0 items-center gap-1.5 text-lg font-bold text-indigo-700">
          <span aria-hidden>⛪</span> <span className="hidden min-[380px]:inline">Numbers</span>
        </Link>
        <nav className="flex min-w-0 items-center gap-0.5 overflow-x-auto sm:gap-2" aria-label="Main">
          {LINKS.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`whitespace-nowrap rounded-lg px-2 py-1.5 text-sm font-medium sm:px-3 ${
                  active ? "bg-indigo-50 text-indigo-700" : "text-stone-600 hover:bg-stone-100"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
          <button
            onClick={() => signOut()}
            className="ml-1 hidden rounded-lg px-3 py-1.5 text-sm text-stone-500 hover:bg-stone-100 sm:block"
            title={`Signed in as ${userName}`}
          >
            Sign out
          </button>
        </nav>
      </div>
    </header>
  );
}
