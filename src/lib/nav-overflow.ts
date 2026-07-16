/**
 * Adaptive top-nav layout planner (Phase 2 + 3 of the nav-crowding work).
 *
 * A pure function so the escalation logic is unit-tested without a DOM. The
 * NavTabs component measures real widths and feeds them here; the plan escalates
 * in three stages as horizontal room runs out:
 *
 *   1. full     — every tab shows its icon AND label
 *   2. icon-only — labels drop to sr-only (Phase 3), all tabs still visible
 *   3. overflow  — icon-only, and the lowest-priority tabs collapse into a
 *                  "More" menu (Phase 2)
 *
 * Priority decides collapse order (lowest first). A tab carrying a work badge
 * gets a large boost so it outranks every unbadged tab — the "badged tabs never
 * collapse while an unbadged one is still visible" rule. `pinned` tabs (the home
 * tab) never collapse at all. Anything that still lands in overflow surfaces its
 * badge on the More trigger, so a pending-work signal is never lost.
 */

export interface NavMeasure {
  href: string;
  /** Rendered width with icon + label. */
  fullWidth: number;
  /** Rendered width icon-only (label sr-only). */
  iconWidth: number;
  /** Base importance; lower collapses first. */
  priority: number;
  hasBadge: boolean;
  /** Never collapses (e.g. the home tab). */
  pinned?: boolean;
}

export interface NavPlan {
  iconOnly: boolean;
  /** hrefs to render in the row, original order preserved. */
  visible: string[];
  /** hrefs to render in the More menu, original order preserved. */
  overflow: string[];
}

/** A badged tab outranks any unbadged tab, whatever their base priorities. */
export const BADGE_BOOST = 1_000_000;

function effectivePriority(t: NavMeasure): number {
  return t.priority + (t.hasBadge ? BADGE_BOOST : 0);
}

/** Total width of a row of items laid out with a fixed gap between them. */
function rowWidth(widths: number[], gap: number): number {
  if (widths.length === 0) return 0;
  const sum = widths.reduce((a, b) => a + b, 0);
  return sum + gap * (widths.length - 1);
}

export function planNav(
  tabs: NavMeasure[],
  available: number,
  moreWidth: number,
  gap: number
): NavPlan {
  const hrefs = tabs.map((t) => t.href);

  // Stage 1: everything fits with labels.
  if (rowWidth(tabs.map((t) => t.fullWidth), gap) <= available) {
    return { iconOnly: false, visible: hrefs, overflow: [] };
  }
  // Stage 2: everything fits icon-only.
  if (rowWidth(tabs.map((t) => t.iconWidth), gap) <= available) {
    return { iconOnly: true, visible: hrefs, overflow: [] };
  }

  // Stage 3: icon-only + collapse the lowest-priority tabs into More until the
  // remaining icons plus the More trigger fit.
  const kept = new Set(hrefs);
  const keptFits = () => {
    const widths = tabs.filter((t) => kept.has(t.href)).map((t) => t.iconWidth);
    return rowWidth([...widths, moreWidth], gap) <= available;
  };
  const dropOrder = tabs
    .filter((t) => !t.pinned)
    .sort((a, b) => effectivePriority(a) - effectivePriority(b));
  for (const t of dropOrder) {
    if (keptFits()) break;
    kept.delete(t.href);
  }

  return {
    iconOnly: true,
    visible: tabs.filter((t) => kept.has(t.href)).map((t) => t.href),
    overflow: tabs.filter((t) => !kept.has(t.href)).map((t) => t.href),
  };
}
