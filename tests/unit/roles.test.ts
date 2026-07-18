import { describe, expect, it } from "vitest";
import { searchCapabilities, type RoleDutyFlags } from "@/lib/roles";

/**
 * Search capability matrix (docs/SEARCH_DESIGN.md §6.3): the verified role
 * mirror narrowed by the A10 duty pauses. canAll = whole-church read (+ foreign
 * receipt files); canDecided = the "Claims I decided" browse, gated on the
 * Approvals duty specifically. Duty pauses narrow per-duty.
 */

const flags = (over: Partial<RoleDutyFlags>): RoleDutyFlags => ({
  role: "member",
  approvalsPaused: false,
  financePaused: false,
  adminPaused: false,
  ...over,
});

describe("searchCapabilities", () => {
  it("member: no elevated scopes ever", () => {
    expect(searchCapabilities(flags({ role: "member" }))).toEqual({ canAll: false, canDecided: false });
  });

  it("chairman/secretary: executive officers get NO read grant (role management only, A11)", () => {
    for (const role of ["chairman", "secretary"]) {
      expect(searchCapabilities(flags({ role }))).toEqual({ canAll: false, canDecided: false });
    }
  });

  it("active approver: whole-church + decided", () => {
    expect(searchCapabilities(flags({ role: "approver" }))).toEqual({ canAll: true, canDecided: true });
  });

  it("approver who pauses approvals loses BOTH scopes (no other duty to fall back on)", () => {
    expect(searchCapabilities(flags({ role: "approver", approvalsPaused: true }))).toEqual({
      canAll: false,
      canDecided: false,
    });
  });

  it("treasurer who pauses ONLY approvals keeps whole-church (finance active) but loses decided", () => {
    expect(searchCapabilities(flags({ role: "treasurer", approvalsPaused: true }))).toEqual({
      canAll: true,
      canDecided: false,
    });
  });

  it("treasurer who pauses ONLY finance keeps everything (approvals still decides)", () => {
    expect(searchCapabilities(flags({ role: "treasurer", financePaused: true }))).toEqual({
      canAll: true,
      canDecided: true,
    });
  });

  it("treasurer who pauses BOTH duties reads like a member", () => {
    expect(
      searchCapabilities(flags({ role: "treasurer", approvalsPaused: true, financePaused: true }))
    ).toEqual({ canAll: false, canDecided: false });
  });

  it("admin keeps whole-church via the admin duty even with approvals+finance paused", () => {
    expect(
      searchCapabilities(flags({ role: "admin", approvalsPaused: true, financePaused: true }))
    ).toEqual({ canAll: true, canDecided: false });
  });

  it("admin who pauses ALL THREE duties reads like a member", () => {
    expect(
      searchCapabilities(
        flags({ role: "admin", approvalsPaused: true, financePaused: true, adminPaused: true })
      )
    ).toEqual({ canAll: false, canDecided: false });
  });

  it("canDecided always implies canAll", () => {
    for (const role of ["approver", "treasurer", "admin"]) {
      for (const p of [true, false]) {
        for (const f of [true, false]) {
          for (const a of [true, false]) {
            const caps = searchCapabilities(
              flags({ role, approvalsPaused: p, financePaused: f, adminPaused: a })
            );
            if (caps.canDecided) expect(caps.canAll).toBe(true);
          }
        }
      }
    }
  });
});
