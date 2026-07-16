"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { planNav, type NavMeasure, type NavPlan } from "@/lib/nav-overflow";
import { MoreIcon } from "./nav-icons";

export interface NavLink {
  href: string;
  label: string;
  icon: ReactNode;
  badge?: number;
  priority: number;
  pinned?: boolean;
}

function testId(href: string): string {
  return `nav-tab-${href.slice(1) || "shoebox"}`;
}
function badgeId(href: string): string {
  return `badge-${href.slice(1) || "shoebox"}`;
}
function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The functional tab row. Renders as much as fits, escalating full → icon-only
 * → overflow via planNav against measured widths (two hidden measurement rows
 * feed real per-tab widths for both modes). See src/lib/nav-overflow.ts.
 */
export default function NavTabs({ links }: { links: NavLink[] }) {
  const pathname = usePathname();
  const t = useTranslations("NavBar");

  const containerRef = useRef<HTMLDivElement>(null);
  const fullRefs = useRef(new Map<string, HTMLElement>());
  const iconRefs = useRef(new Map<string, HTMLElement>());
  const moreMeasureRef = useRef<HTMLSpanElement>(null);
  const moreWrapRef = useRef<HTMLDivElement>(null);

  const [plan, setPlan] = useState<NavPlan>(() => ({
    iconOnly: false,
    visible: links.map((l) => l.href),
    overflow: [],
  }));
  const [moreOpen, setMoreOpen] = useState(false);

  // A stable signature so the measure effect only re-runs when the tab set,
  // labels, or badges actually change (not on every parent render).
  const signature = links
    .map((l) => `${l.href}:${l.label}:${l.badge ?? ""}:${l.priority}:${l.pinned ? 1 : 0}`)
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
    }));
    const moreWidth = moreMeasureRef.current?.getBoundingClientRect().width ?? 0;
    const next = planNav(tabs, available, moreWidth, gap);
    setPlan((prev) =>
      prev.iconOnly === next.iconOnly &&
      sameArray(prev.visible, next.visible) &&
      sameArray(prev.overflow, next.overflow)
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

  // Close the overflow menu on navigation, outside click, or Escape.
  useEffect(() => setMoreOpen(false), [pathname]);
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreWrapRef.current && !moreWrapRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const byHref = new Map(links.map((l) => [l.href, l]));
  const visible = plan.visible.map((h) => byHref.get(h)).filter((l): l is NavLink => !!l);
  const overflow = plan.overflow.map((h) => byHref.get(h)).filter((l): l is NavLink => !!l);
  const overflowBadge = overflow.some((l) => l.badge);

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
        {...(measuring ? {} : { "data-testid": testId(l.href) })}
      >
        <span aria-hidden>{l.icon}</span>
        <span className={iconOnly ? "sr-only" : ""}>{l.label}</span>
        {l.badge ? (
          <span
            className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white"
            {...(measuring ? {} : { "data-testid": badgeId(l.href) })}
          >
            {measuring ? null : <span className="sr-only">{t("pendingWork")}</span>}
          </span>
        ) : null}
      </Link>
    );
  }

  return (
    <div ref={containerRef} className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden py-1">
      {visible.map((l) => renderTab(l, plan.iconOnly, false))}

      {overflow.length > 0 ? (
        <div ref={moreWrapRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-haspopup="true"
            aria-expanded={moreOpen}
            aria-label={t("more")}
            data-testid="nav-more"
            className="relative flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-stone-600 hover:bg-stone-100"
          >
            <MoreIcon />
            <span className="sr-only">{t("more")}</span>
            {overflowBadge ? (
              <span
                className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white"
                data-testid="badge-more"
              >
                <span className="sr-only">{t("pendingWork")}</span>
              </span>
            ) : null}
          </button>
          {moreOpen ? (
            <div
              aria-label={t("more")}
              className="absolute right-0 top-full z-50 mt-1.5 w-52 rounded-xl border border-stone-200 bg-white p-1.5 shadow-lg"
            >
              {overflow.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  data-testid={testId(l.href)}
                  className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-sm ${
                    isActive(l.href)
                      ? "bg-indigo-50 text-indigo-700"
                      : "text-stone-700 hover:bg-stone-100"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span aria-hidden>{l.icon}</span>
                    {l.label}
                  </span>
                  {l.badge ? (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-red-500"
                      data-testid={badgeId(l.href)}
                    >
                      <span className="sr-only">{t("pendingWork")}</span>
                    </span>
                  ) : null}
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

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
        <span ref={moreMeasureRef} className="inline-flex">
          <span className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium sm:px-3">
            <MoreIcon />
          </span>
        </span>
      </div>
    </div>
  );
}
