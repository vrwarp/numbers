import { describe, expect, it } from "vitest";
import { planNav, type NavMeasure } from "@/lib/nav-overflow";

/**
 * The adaptive nav planner escalates full → icon-only → overflow, and protects
 * badged tabs (they outrank unbadged ones) and the pinned home tab from
 * collapsing. Widths here are synthetic; the component supplies real ones.
 */

const TABS: NavMeasure[] = [
  { href: "/", fullWidth: 80, iconWidth: 30, priority: 100, hasBadge: false, pinned: true },
  { href: "/claims", fullWidth: 70, iconWidth: 30, priority: 90, hasBadge: false },
  { href: "/approvals", fullWidth: 90, iconWidth: 30, priority: 80, hasBadge: true },
  { href: "/finance", fullWidth: 75, iconWidth: 30, priority: 70, hasBadge: false },
];
const GAP = 4;
// full row = 315 + 3*4 = 327; icon row = 120 + 12 = 132

describe("planNav", () => {
  it("keeps every label when the full row fits", () => {
    const plan = planNav(TABS, 400, 40, GAP);
    expect(plan.iconOnly).toBe(false);
    expect(plan.visible).toEqual(["/", "/claims", "/approvals", "/finance"]);
    expect(plan.overflow).toEqual([]);
  });

  it("drops to icon-only before collapsing anything", () => {
    // 200 < 327 (full) but >= 132 (icon row).
    const plan = planNav(TABS, 200, 40, GAP);
    expect(plan.iconOnly).toBe(true);
    expect(plan.visible).toHaveLength(4);
    expect(plan.overflow).toEqual([]);
  });

  it("collapses lowest-priority tabs but protects the badged one", () => {
    // 120 < 132: even icon-only overflows. Badge boost keeps /approvals visible
    // while the unbadged /claims and /finance collapse; /  is pinned.
    const plan = planNav(TABS, 120, 40, GAP);
    expect(plan.iconOnly).toBe(true);
    expect(plan.visible).toContain("/approvals");
    expect(plan.visible).toContain("/");
    expect(plan.overflow).toEqual(["/claims", "/finance"]);
  });

  it("never collapses the pinned tab and surfaces overflow in order", () => {
    // Absurdly narrow: only the pinned home tab survives.
    const plan = planNav(TABS, 60, 40, GAP);
    expect(plan.visible).toEqual(["/"]);
    // Original order preserved in the overflow list.
    expect(plan.overflow).toEqual(["/claims", "/approvals", "/finance"]);
  });

  it("treats a badge as higher priority than any base priority", () => {
    // /finance is lowest base priority but the only badged tab → it stays,
    // the higher-base /claims collapses first.
    const badgedFinance = TABS.map((t) =>
      t.href === "/finance"
        ? { ...t, hasBadge: true }
        : t.href === "/approvals"
          ? { ...t, hasBadge: false }
          : t
    );
    const plan = planNav(badgedFinance, 120, 40, GAP);
    expect(plan.visible).toContain("/finance");
    expect(plan.overflow).not.toContain("/finance");
  });
});
