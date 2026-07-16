"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { planNav, type NavMeasure, type NavPlan } from "@/lib/nav-overflow";

export interface NavLink {
  href: string;
  label: string;
  icon: ReactNode;
  badge?: number;
  priority: number;
  pinned?: boolean;
  keepLabel?: boolean;
}

export function navTestId(href: string): string {
  return `nav-tab-${href.slice(1) || "shoebox"}`;
}
export function navBadgeId(href: string): string {
  return `badge-${href.slice(1) || "shoebox"}`;
}
function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The functional tab row. Renders as much as fits, escalating full → compress →
 * overflow via planNav against measured widths (two hidden measurement rows feed
 * real per-tab widths for both modes). Reduced tabs — compressed to icons or
 * overflowed out — are reported up via onMenuChange so the parent can list them
 * (with labels) in the account menu; there is no separate "More" dropdown. See
 * src/lib/nav-overflow.ts.
 */
export default function NavTabs({
  links,
  onMenuChange,
}: {
  links: NavLink[];
  /** Tabs to also surface in the account menu (compressed icons + overflowed),
   *  in original order, plus which of those are hidden from the row (overflow)
   *  — the hidden badged ones drive the avatar's aggregated dot. */
  onMenuChange?: (menu: string[], overflow: string[]) => void;
}) {
  const pathname = usePathname();
  const t = useTranslations("NavBar");

  const containerRef = useRef<HTMLDivElement>(null);
  const fullRefs = useRef(new Map<string, HTMLElement>());
  const iconRefs = useRef(new Map<string, HTMLElement>());

  const [plan, setPlan] = useState<NavPlan>(() => ({
    visible: links.map((l) => ({ href: l.href, iconOnly: false })),
    overflow: [],
  }));

  // A stable signature so the measure effect only re-runs when the tab set,
  // labels, or badges actually change (not on every parent render).
  const signature = links
    .map((l) => `${l.href}:${l.label}:${l.badge ?? ""}:${l.priority}:${l.pinned ? 1 : 0}:${l.keepLabel ? 1 : 0}`)
    .join("|");

  const recompute = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const available = container.clientWidth;
    const gap = parseFloat(getComputedStyle(container).columnGap || "0") || 0;
    const widthOf = (m: Map<string, HTMLElement>, href: string) =>
      m.get(href)?.getBoundingClientRect().width ?? 0;
    const tabs: NavMeasure[] = links.map((l) => ({
      href: l.href,
      fullWidth: widthOf(fullRefs.current, l.href),
      iconWidth: widthOf(iconRefs.current, l.href),
      priority: l.priority,
      hasBadge: !!l.badge,
      pinned: l.pinned,
      keepLabel: l.keepLabel,
    }));
    const next = planNav(tabs, available, gap);
    setPlan((prev) =>
      sameArray(
        prev.visible.map((v) => `${v.href}:${v.iconOnly}`),
        next.visible.map((v) => `${v.href}:${v.iconOnly}`)
      ) && sameArray(prev.overflow, next.overflow)
        ? prev
        : next
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useLayoutEffect(recompute, [recompute]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(recompute);
    ro.observe(container);
    return () => ro.disconnect();
  }, [recompute]);

  // Report the tabs to surface in the account menu (compressed icons +
  // overflowed) up to the parent (the menu owner). A compressed tab stays in
  // the row as an icon AND appears in the menu with its label, so there's always
  // a labeled way to reach it.
  const compressedKey = plan.visible.filter((v) => v.iconOnly).map((v) => v.href).join("|");
  const overflowKey = plan.overflow.join("|");
  useEffect(() => {
    const overflow = plan.overflow;
    const reduced = new Set([...plan.visible.filter((v) => v.iconOnly).map((v) => v.href), ...overflow]);
    const menu = links.filter((l) => reduced.has(l.href)).map((l) => l.href);
    onMenuChange?.(menu, overflow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compressedKey, overflowKey]);

  const byHref = new Map(links.map((l) => [l.href, l]));
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  function tabClass(active: boolean, measuring: boolean): string {
    return `relative flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-sm font-medium sm:px-3 ${
      active ? "bg-indigo-50 text-indigo-700" : "text-stone-600 hover:bg-stone-100"
    }${measuring ? " pointer-events-none" : ""}`;
  }

  function renderTab(l: NavLink, iconOnly: boolean, measuring: boolean) {
    return (
      <Link
        key={(measuring ? "m:" : "") + l.href}
        href={l.href}
        aria-hidden={measuring || undefined}
        tabIndex={measuring ? -1 : undefined}
        className={tabClass(!measuring && isActive(l.href), measuring)}
        {...(measuring ? {} : { "data-testid": navTestId(l.href) })}
      >
        <span aria-hidden>{l.icon}</span>
        <span className={iconOnly ? "sr-only" : ""}>{l.label}</span>
        {l.badge ? (
          <span
            className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white"
            {...(measuring ? {} : { "data-testid": navBadgeId(l.href) })}
          >
            {measuring ? null : <span className="sr-only">{t("pendingWork")}</span>}
          </span>
        ) : null}
      </Link>
    );
  }

  return (
    <div ref={containerRef} className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden py-1">
      {plan.visible.map((v) => {
        const l = byHref.get(v.href);
        return l ? renderTab(l, v.iconOnly, false) : null;
      })}

      {/* Hidden measurement rows: real per-tab widths for both render modes.
          aria-hidden + no test ids so they never double up with the live row. */}
      <div
        aria-hidden
        className="invisible pointer-events-none absolute -left-[9999px] top-0 flex items-center gap-1"
      >
        {links.map((l) => (
          <span key={l.href} ref={(el) => void (el && fullRefs.current.set(l.href, el))} className="inline-flex">
            {renderTab(l, false, true)}
          </span>
        ))}
      </div>
      <div
        aria-hidden
        className="invisible pointer-events-none absolute -left-[9999px] top-0 flex items-center gap-1"
      >
        {links.map((l) => (
          <span key={l.href} ref={(el) => void (el && iconRefs.current.set(l.href, el))} className="inline-flex">
            {renderTab(l, true, true)}
          </span>
        ))}
      </div>
    </div>
  );
}
