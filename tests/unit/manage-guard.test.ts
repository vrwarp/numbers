import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canManageOrg } from "@/lib/manage-guard";

/**
 * canManageOrg gates the "Manage" nav entry and the /manage hub — the union of
 * the per-tool guards. isAppAdmin reads ADMIN_EMAILS through configValue, so an
 * isolated DATA_DIR keeps it empty (role-only) per test.
 */
describe("canManageOrg", () => {
  const oldEnv = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "numbers-manage-"));
    process.env.DATA_DIR = dir;
    delete process.env.ADMIN_EMAILS;
  });
  afterEach(() => {
    process.env = { ...oldEnv };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const u = (over: Partial<{ role: string; email: string }> = {}) => ({
    email: "u@x.org",
    role: "member",
    ...over,
  });

  it("is false for a plain member", () => {
    expect(canManageOrg(u())).toBe(false);
  });

  it("is true for any approver-or-above with an active duty", () => {
    for (const role of ["approver", "secretary", "chairman", "treasurer", "admin"]) {
      expect(canManageOrg(u({ role })), role).toBe(true);
    }
  });

  it("drops to false once a role-holder pauses every duty they hold", () => {
    // A treasurer holds approvals + finance; pausing both reads like a member.
    expect(
      canManageOrg({ ...u({ role: "treasurer" }), approvalsPaused: true, financePaused: true })
    ).toBe(false);
    // One active duty is enough to keep the whole cluster.
    expect(
      canManageOrg({ ...u({ role: "treasurer" }), approvalsPaused: true, financePaused: false })
    ).toBe(true);
  });

  it("keeps an admin who paused only the admin duty (other duties still grant the tools)", () => {
    // isAppAdmin fails, but approvals/finance are still active, so the
    // master-data tools (and thus the Manage entry) remain.
    expect(canManageOrg({ ...u({ role: "admin" }), adminPaused: true })).toBe(true);
    // Pausing every duty finally closes it.
    expect(
      canManageOrg({
        ...u({ role: "admin" }),
        adminPaused: true,
        approvalsPaused: true,
        financePaused: true,
      })
    ).toBe(false);
  });

  it("honors ADMIN_EMAILS as an admin path", () => {
    process.env.ADMIN_EMAILS = "pastor@church.org";
    expect(canManageOrg({ email: "pastor@church.org", role: "member" })).toBe(true);
    expect(canManageOrg({ email: "pastor@church.org", role: "member", adminPaused: true })).toBe(false);
  });
});
