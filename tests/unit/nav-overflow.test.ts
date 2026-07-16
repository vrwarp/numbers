import { describe, expect, it } from "vitest";
import { planNav, type NavMeasure } from "@/lib/nav-overflow";

/**
 * The adaptive nav planner escalates full → compress → overflow. Receipts and
 * Claims keep their labels and never collapse (pinned + keepLabel); the role
 * tabs compress to icons, then collapse into the account menu. Badged tabs
 * outrank unbadged ones. Widths here are synthetic; the component supplies real
 * ones.
 */

const TABS: NavMeasure[] = [
  { href: "/", fullWidth: 100, iconWidth: 34, priority: 100, hasBadge: false, pinned: true, keepLabel: true },
  { href: "/claims", fullWidth: 84, iconWidth: 34, priority: 90, hasBadge: false, pinned: true, keepLabel: true },
  { href: "/approvals", fullWidth: 96, iconWidth: 34, priority: 80, hasBadge: true },
  { href: "/finance", fullWidth: 80, iconWidth: 34, priority: 70, hasBadge: false },
];
const GAP = 4;
// full row = 360 + 12 = 372; compressed (R/C full, A/F icon) = 100+84+34+34 + 12 = 264

const iconOnly = (plan: ReturnType<typeof planNav>, href: string) =>
  plan.visible.find((v) => v.href === href)?.iconOnly;

describe("planNav", () => {
  it("keeps every label when the full row fits", () => {
    const plan = planNav(TABS, 400, GAP);
    expect(plan.visible.map((v) => v.href)).toEqual(["/", "/claims", "/approvals", "/finance"]);
    expect(plan.visible.every((v) => !v.iconOnly)).toBe(true);
    expect(plan.overflow).toEqual([]);
  });

  it("compresses only the role tabs, never Receipts/Claims", () => {
    // 300: full (372) doesn't fit, compressed (264) does.
    const plan = planNav(TABS, 300, GAP);
    expect(plan.overflow).toEqual([]);
    expect(iconOnly(plan, "/")).toBe(false);
    expect(iconOnly(plan, "/claims")).toBe(false);
    expect(iconOnly(plan, "/approvals")).toBe(true);
    expect(iconOnly(plan, "/finance")).toBe(true);
  });

  it("collapses lowest-priority role tabs into overflow, keeping Receipts/Claims labeled", () => {
    // 250: even compressed (264) overflows. Drop /finance (lowest); /approvals
    // is badged so it survives as an icon.
    const plan = planNav(TABS, 250, GAP);
    expect(plan.overflow).toEqual(["/finance"]);
    expect(plan.visible.map((v) => v.href)).toEqual(["/", "/claims", "/approvals"]);
    expect(iconOnly(plan, "/")).toBe(false);
    expect(iconOnly(plan, "/claims")).toBe(false);
    expect(iconOnly(plan, "/approvals")).toBe(true);
  });

  it("never collapses the pinned Receipts/Claims and overflows both role tabs when tiny", () => {
    // 210: only the two pinned labeled tabs survive.
    const plan = planNav(TABS, 210, GAP);
    expect(plan.visible.map((v) => v.href)).toEqual(["/", "/claims"]);
    expect(plan.visible.every((v) => !v.iconOnly)).toBe(true);
    expect(plan.overflow).toEqual(["/approvals", "/finance"]);
  });

  it("treats a badge as higher priority than any base priority", () => {
    // /finance lowest base priority but the only badged tab → it stays, the
    // higher-base /approvals collapses first.
    const badgedFinance = TABS.map((t) =>
      t.href === "/finance"
        ? { ...t, hasBadge: true }
        : t.href === "/approvals"
          ? { ...t, hasBadge: false }
          : t
    );
    const plan = planNav(badgedFinance, 250, GAP);
    expect(plan.visible.map((v) => v.href)).toContain("/finance");
    expect(plan.overflow).toEqual(["/approvals"]);
  });
});
