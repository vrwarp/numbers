import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canManageTeams } from "@/lib/teams-guard";

// canManageTeams → isAppAdmin, which reads ADMIN_EMAILS via configValue()
// (DATA_DIR config file overlaid on process.env). Isolate to a fileless
// DATA_DIR so the ADMIN_EMAILS we set here is the only grant in play.
const oldEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "numbers-tg-"));
  process.env.DATA_DIR = dir;
  delete process.env.ADMIN_EMAILS;
});
afterEach(() => {
  process.env = { ...oldEnv };
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("canManageTeams", () => {
  it("every Approver-or-above role qualifies while its duties are active (teams are opened wider than ministries)", () => {
    for (const role of ["approver", "secretary", "chairman", "treasurer", "admin"]) {
      expect(canManageTeams({ role, email: "x@church.org" })).toBe(true);
    }
  });

  it("plain members do not", () => {
    expect(canManageTeams({ role: "member", email: "m@church.org" })).toBe(false);
    expect(canManageTeams({ role: "", email: "x@church.org" })).toBe(false);
  });

  it("A10 pauses narrow team management like the role-read grant: no active duty, no editor", () => {
    // Approver-tier roles hold only the Approvals duty — pausing it ends it.
    for (const role of ["approver", "secretary", "chairman"]) {
      expect(canManageTeams({ role, email: "a@church.org", approvalsPaused: true })).toBe(false);
    }
  });

  it("a treasurer keeps the editor while ANY granted duty is active, loses it when all are paused", () => {
    expect(canManageTeams({ role: "treasurer", email: "t@church.org", approvalsPaused: true })).toBe(true);
    expect(
      canManageTeams({ role: "treasurer", email: "t@church.org", approvalsPaused: true, financePaused: true })
    ).toBe(false);
  });

  it("an admin keeps it via the admin duty until all three duties are paused", () => {
    expect(
      canManageTeams({ role: "admin", email: "a@church.org", approvalsPaused: true, financePaused: true })
    ).toBe(true);
    expect(
      canManageTeams({
        role: "admin",
        email: "a@church.org",
        approvalsPaused: true,
        financePaused: true,
        adminPaused: true,
      })
    ).toBe(false);
  });

  it("an ADMIN_EMAILS address qualifies even as a member (case-insensitive), unless admin-paused", () => {
    process.env.ADMIN_EMAILS = "boss@church.org";
    expect(canManageTeams({ role: "member", email: "BOSS@Church.ORG" })).toBe(true);
    expect(canManageTeams({ role: "member", email: "boss@church.org", adminPaused: true })).toBe(false);
    expect(canManageTeams({ role: "member", email: "notboss@church.org" })).toBe(false);
  });
});
