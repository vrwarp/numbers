import { describe, expect, it } from "vitest";
import {
  CLICK_ROUTE_PREFIXES,
  KIND_SPECS,
  NOTIFICATION_KINDS,
  eventExpired,
  isAllowedClickRoute,
} from "@/lib/notifications/catalog";
import { composePush } from "@/lib/notifications/compose";
import { backoffMs, recipientWantsPush, type PushRecipient } from "@/lib/notifications/policy";
import { parseQuietWindows, quietHoldMs } from "@/lib/notifications/settings";
import { wireTopic } from "@/lib/notifications/send";
import { LOCALES } from "@/lib/locales";

/** docs/NOTIFICATIONS_DESIGN.md §9.1/§7.3/§7.4 gates. */

describe("composition (§9.1 gate: every kind × locale × empty label)", () => {
  const params = { occurredAt: new Date().toISOString() };
  for (const kind of NOTIFICATION_KINDS) {
    for (const locale of LOCALES) {
      it(`${kind} composes a complete sentence in ${locale} with no label`, () => {
        const { title } = composePush(kind, params, { locale });
        expect(title.length).toBeGreaterThan(0);
        // No dangling separator when the optional label is missing.
        expect(title.trim()).not.toMatch(/[—\-–:]$/);
        expect(title).not.toContain("{");
      });
      it(`${kind} composes with a label in ${locale}`, () => {
        const { title, body } = composePush(
          kind,
          { ...params, label: "Retreat 2026", name: "Mary Chen" },
          { locale, count: 2 }
        );
        expect(title).not.toContain("{");
        expect(body).not.toContain("{");
      });
    }
  }

  it("labeled titles carry the label (action first, label last)", () => {
    const { title } = composePush("signing-request", { ...params, label: "Retreat 2026" }, { locale: "en" });
    expect(title).toBe("Signature requested — Retreat 2026");
    expect(title.indexOf("Signature")).toBe(0);
  });

  it("discreet mode is outcome- and name-neutral for claim kinds only", () => {
    const rejected = composePush(
      "claim-rejected",
      { ...params, label: "Funeral flowers — Wang family" },
      { locale: "en", discreet: true }
    );
    expect(rejected.title).not.toContain("Wang");
    expect(rejected.title).not.toContain("changes");
    const device = composePush("device-request", params, { locale: "en", discreet: true });
    expect(device.title).toContain("device");
  });

  it("finance coalescing pluralizes on count", () => {
    const one = composePush("finance-queue", { ...params, label: "Retreat" }, { locale: "en", count: 1 });
    const three = composePush("finance-queue", params, { locale: "en", count: 3 });
    expect(one.title).toContain("A claim");
    expect(one.body).toContain("Retreat");
    expect(three.title).toContain("3");
    expect(three.body).toBe("");
  });
});

describe("age gate (§7.3: FCM TTL bounds FCM's queue, not ours)", () => {
  it("expires a device-request after its 30-minute urgency", () => {
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    expect(eventExpired("device-request", old, Date.now())).toBe(true);
    const fresh = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(eventExpired("device-request", fresh, Date.now())).toBe(false);
  });
  it("keeps a signing request live for days", () => {
    const twoDays = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    expect(eventExpired("signing-request", twoDays, Date.now())).toBe(false);
  });
  it("fails closed on malformed timestamps", () => {
    expect(eventExpired("claim-paid", "not-a-date", Date.now())).toBe(true);
  });
});

describe("wire topic (§7.4: RFC 8030 — ≤32 chars, base64url only)", () => {
  it("hashes readable tags into legal Topics", () => {
    for (const kind of NOTIFICATION_KINDS) {
      const tag = KIND_SPECS[kind].tag("user_1", "claim_1");
      const topic = wireTopic(tag);
      expect(topic.length).toBeLessThanOrEqual(32);
      expect(topic).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
  it("is stable per tag and distinct across tags", () => {
    expect(wireTopic("a")).toBe(wireTopic("a"));
    expect(wireTopic("a")).not.toBe(wireTopic("b"));
  });
});

describe("click-route allowlist (§7.5)", () => {
  it("accepts catalog routes", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(isAllowedClickRoute(KIND_SPECS[kind].route("abc"))).toBe(true);
    }
    for (const p of CLICK_ROUTE_PREFIXES) {
      // Bare "/claims/" (no id) is not a page — prefixes with a trailing
      // slash are valid only with something after them.
      if (!p.endsWith("/") || p === "/") expect(isAllowedClickRoute(p)).toBe(true);
    }
    expect(isAllowedClickRoute("/claims/abc")).toBe(true);
    expect(isAllowedClickRoute("/approvals?open=xyz")).toBe(true);
  });
  it("rejects off-origin and off-catalog routes", () => {
    expect(isAllowedClickRoute("https://evil.example")).toBe(false);
    expect(isAllowedClickRoute("//evil.example")).toBe(false);
    expect(isAllowedClickRoute("/admin")).toBe(false);
    expect(isAllowedClickRoute("/approvalsevil")).toBe(false);
    expect(isAllowedClickRoute("/claims/")).toBe(false);
    expect(isAllowedClickRoute("")).toBe(false);
  });
});

describe("send-time preference policy (§7.3 — enqueue is unconditional)", () => {
  const base: PushRecipient = {
    role: "member",
    notifyEnabled: true,
    notifySigning: true,
    notifyClaimProgress: true,
    notifyFinance: true,
    notifySecurity: true,
    financePaused: false,
  };
  it("master off silences everything, self-test included", () => {
    const off = { ...base, notifyEnabled: false };
    for (const kind of NOTIFICATION_KINDS) expect(recipientWantsPush(off, kind)).toBe(false);
  });
  it("self-test needs only the master switch", () => {
    const noCats = {
      ...base,
      notifySigning: false,
      notifyClaimProgress: false,
      notifyFinance: false,
      notifySecurity: false,
    };
    expect(recipientWantsPush(noCats, "self-test")).toBe(true);
    expect(recipientWantsPush(noCats, "claim-paid")).toBe(false);
  });
  it("finance re-checks role and pause at send time", () => {
    expect(recipientWantsPush({ ...base, role: "treasurer" }, "finance-queue")).toBe(true);
    expect(recipientWantsPush({ ...base, role: "treasurer", financePaused: true }, "finance-queue")).toBe(false);
    expect(recipientWantsPush(base, "finance-queue")).toBe(false); // demoted since enqueue
  });
  it("backoff doubles from 30s", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(3)).toBe(240_000);
  });
});

describe("§5 stale-tap empty-state copy contract", () => {
  // The bypassed-approver finding (revision log round 4 #1): /approvals copy
  // must be cause-neutral and normalizing — "already handled by someone
  // else" decodes to "you were passed over" when requests name ONE approver.
  it("approvals empty state normalizes withdrawal and never implies a cause", async () => {
    const en = (await import("../../messages/en.json")).default;
    expect(en.Approvals.empty).toMatch(/withdraw or reassign/i);
    expect(en.Approvals.empty.toLowerCase()).not.toContain("someone else");
    expect(en.Approvals.openGone.toLowerCase()).not.toContain("someone else");
    // Finance genuinely is a shared queue — "already handled" is accurate there.
    expect(en.Finance.empty.toLowerCase()).toContain("handled");
  });
});

describe("quiet window (dormant §7.3 — hold-then-send math)", () => {
  const windows = parseQuietWindows("21:30-08:00,sun:09:00-12:30");
  const at = (dow: number, h: number, m: number) => {
    // 2026-07-19 is a Sunday; add days to reach the wanted weekday.
    const d = new Date(2026, 6, 19 + ((dow + 7) % 7), h, m, 0);
    return d;
  };
  it("parses overnight + dow-scoped windows", () => {
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ startMin: 21 * 60 + 30, endMin: 8 * 60 });
    expect(windows[1]).toMatchObject({ dow: 0 });
  });
  it("holds inside the overnight window, across midnight", () => {
    expect(quietHoldMs(windows, at(2, 23, 0))).toBeGreaterThan(0); // Tue 23:00
    expect(quietHoldMs(windows, at(3, 6, 0))).toBeGreaterThan(0); // Wed 06:00 (wrap)
    expect(quietHoldMs(windows, at(3, 12, 0))).toBe(0); // Wed noon
  });
  it("holds during the Sunday service block only on Sunday", () => {
    expect(quietHoldMs(windows, at(0, 10, 0))).toBeGreaterThan(0); // Sun 10:00
    expect(quietHoldMs(windows, at(1, 10, 0))).toBe(0); // Mon 10:00
  });
  it("releases at the window edge", () => {
    const hold = quietHoldMs(windows, at(0, 12, 29));
    expect(hold).toBeGreaterThan(0);
    expect(hold).toBeLessThanOrEqual(60_000);
    expect(quietHoldMs(windows, at(0, 12, 31))).toBe(0);
  });
  it("ignores malformed parts", () => {
    expect(parseQuietWindows("25:99-08:00,garbage,mon:22:00-23:00")).toHaveLength(1);
  });
});
