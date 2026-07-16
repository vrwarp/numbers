import { describe, expect } from "vitest";
import { planNav, BADGE_BOOST, type NavMeasure } from "@/lib/nav-overflow";
import { fuzz, Rng } from "./prng";

function randomTabs(rng: Rng): NavMeasure[] {
  const n = rng.int(0, 10);
  return rng.array(n, (r, i) => {
    const iconWidth = r.int(20, 80);
    return {
      href: `/tab-${i}`,
      iconWidth,
      fullWidth: iconWidth + r.int(0, 160),
      priority: r.int(0, 100),
      hasBadge: r.bool(0.3),
      pinned: r.bool(0.2),
      keepLabel: r.bool(0.2),
    };
  });
}

/**
 * planNav's stage rules are behavioral guarantees the UI relies on
 * (badged tabs never collapse before unbadged ones, pinned tabs never leave
 * the row). Fuzz them across the whole layout space.
 */
describe("planNav fuzz", () => {
  fuzz("visible + overflow is a partition preserving original order", { iters: 500 }, (rng) => {
    const tabs = randomTabs(rng);
    const plan = planNav(tabs, rng.int(0, 1200), rng.int(0, 24));
    const all = [...plan.visible.map((v) => v.href), ...plan.overflow];
    expect(all.sort()).toEqual(tabs.map((t) => t.href).sort());
    // Order preservation within each list.
    const hrefOrder = tabs.map((t) => t.href);
    const idx = (h: string) => hrefOrder.indexOf(h);
    const visIdx = plan.visible.map((v) => idx(v.href));
    expect(visIdx).toEqual([...visIdx].sort((a, b) => a - b));
    const ovIdx = plan.overflow.map(idx);
    expect(ovIdx).toEqual([...ovIdx].sort((a, b) => a - b));
  });

  fuzz("pinned tabs never overflow", { iters: 500 }, (rng) => {
    const tabs = randomTabs(rng);
    const plan = planNav(tabs, rng.int(0, 800), rng.int(0, 24));
    const pinned = new Set(tabs.filter((t) => t.pinned).map((t) => t.href));
    for (const href of plan.overflow) expect(pinned.has(href)).toBe(false);
  });

  fuzz("keepLabel tabs are never rendered icon-only", { iters: 500 }, (rng) => {
    const tabs = randomTabs(rng);
    const plan = planNav(tabs, rng.int(0, 800), rng.int(0, 24));
    const keep = new Set(tabs.filter((t) => t.keepLabel).map((t) => t.href));
    for (const v of plan.visible) {
      if (keep.has(v.href)) expect(v.iconOnly).toBe(false);
    }
  });

  fuzz("a badged tab only overflows after every unbadged droppable tab", { iters: 500 }, (rng) => {
    const tabs = randomTabs(rng);
    const plan = planNav(tabs, rng.int(0, 600), rng.int(0, 24));
    const overflowed = new Set(plan.overflow);
    const badgedOverflowed = tabs.some((t) => t.hasBadge && overflowed.has(t.href));
    if (badgedOverflowed) {
      const unbadgedDroppableVisible = tabs.filter(
        (t) => !t.hasBadge && !t.pinned && !overflowed.has(t.href)
      );
      expect(unbadgedDroppableVisible).toEqual([]);
    }
  });

  fuzz("when everything fits at full width nothing compresses or overflows", { iters: 300 }, (rng) => {
    const tabs = randomTabs(rng);
    const gap = rng.int(0, 24);
    const fullWidth =
      tabs.reduce((a, t) => a + t.fullWidth, 0) + gap * Math.max(0, tabs.length - 1);
    const plan = planNav(tabs, fullWidth + rng.int(0, 50), gap);
    expect(plan.overflow).toEqual([]);
    for (const v of plan.visible) expect(v.iconOnly).toBe(false);
  });

  fuzz("more available width never increases overflow count", { iters: 300 }, (rng) => {
    const tabs = randomTabs(rng);
    const gap = rng.int(0, 24);
    const narrow = rng.int(0, 500);
    const wide = narrow + rng.int(1, 500);
    const planNarrow = planNav(tabs, narrow, gap);
    const planWide = planNav(tabs, wide, gap);
    expect(planWide.overflow.length).toBeLessThanOrEqual(planNarrow.overflow.length);
  });

  fuzz("BADGE_BOOST dominates any realistic base priority", { iters: 100 }, (rng) => {
    expect(rng.int(0, 100_000)).toBeLessThan(BADGE_BOOST);
  });
});
