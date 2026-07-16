/**
 * Adaptive top-nav layout planner (nav-crowding work).
 *
 * A pure function so the escalation logic is unit-tested without a DOM. NavTabs
 * measures real widths and feeds them here; the plan escalates in three stages
 * as horizontal room runs out:
 *
 *   1. full      — every tab shows icon AND label
 *   2. compress  — tabs allowed to (everything except `keepLabel` tabs) drop to
 *                  their icon; Receipts/Claims keep their labels
 *   3. overflow  — the lowest-priority tabs collapse OUT of the row entirely and
 *                  into the existing account menu (there is no separate "More"
 *                  menu — one dropdown), badge aggregated onto the avatar
 *
 * Priority decides collapse order (lowest first). A tab carrying a work badge
 * gets a large boost so it outranks every unbadged tab — the "badged tabs never
 * collapse while an unbadged one is still visible" rule. `pinned` tabs never
 * collapse; `keepLabel` tabs never lose their label. The avatar sits outside the
 * measured row and is always present, so overflow reserves no width for it.
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
  /** Never collapses into the account menu (e.g. Receipts, Claims). */
  pinned?: boolean;
  /** Never compresses to icon-only (e.g. Receipts, Claims). */
  keepLabel?: boolean;
}

export interface NavVisible {
  href: string;
  iconOnly: boolean;
}

export interface NavPlan {
  /** Tabs to render in the row, original order, each with its render mode. */
  visible: NavVisible[];
  /** hrefs that collapsed into the account menu, original order. */
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
  return widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
}

export function planNav(tabs: NavMeasure[], available: number, gap: number): NavPlan {
  const allFull = (): NavVisible[] => tabs.map((t) => ({ href: t.href, iconOnly: false }));
  // A tab's width/mode once compression is allowed: keepLabel stays full.
  const compressedIcon = (t: NavMeasure) => !t.keepLabel;
  const compressedWidth = (t: NavMeasure) => (t.keepLabel ? t.fullWidth : t.iconWidth);

  // Stage 1: everything fits with labels.
  if (rowWidth(tabs.map((t) => t.fullWidth), gap) <= available) {
    return { visible: allFull(), overflow: [] };
  }
  // Stage 2: compress the allowed tabs to icon-only; keepLabel tabs stay full.
  if (rowWidth(tabs.map(compressedWidth), gap) <= available) {
    return {
      visible: tabs.map((t) => ({ href: t.href, iconOnly: compressedIcon(t) })),
      overflow: [],
    };
  }

  // Stage 3: collapse the lowest-priority non-pinned tabs into the account menu
  // until the rest (in their compressed modes) fit.
  const kept = new Set(tabs.map((t) => t.href));
  const keptFits = () =>
    rowWidth(tabs.filter((t) => kept.has(t.href)).map(compressedWidth), gap) <= available;
  const dropOrder = tabs
    .filter((t) => !t.pinned)
    .sort((a, b) => effectivePriority(a) - effectivePriority(b));
  for (const t of dropOrder) {
    if (keptFits()) break;
    kept.delete(t.href);
  }

  return {
    visible: tabs
      .filter((t) => kept.has(t.href))
      .map((t) => ({ href: t.href, iconOnly: compressedIcon(t) })),
    overflow: tabs.filter((t) => !kept.has(t.href)).map((t) => t.href),
  };
}
