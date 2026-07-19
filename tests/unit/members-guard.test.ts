import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canViewMembers } from "@/lib/members-guard";

// canViewMembers → canManageMinistries → isAppAdmin, which reads ADMIN_EMAILS
// via configValue() (DATA_DIR config file overlaid on process.env). Isolate to
// a fileless DATA_DIR so the ADMIN_EMAILS we set here is the only grant in play.
const oldEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "numbers-memg-"));
  process.env.DATA_DIR = dir;
  delete process.env.ADMIN_EMAILS;
});
afterEach(() => {
  process.env = { ...oldEnv };
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("canViewMembers", () => {
  it("executive officers and treasurers/admins qualify while a granted duty is active", () => {
    for (const role of ["secretary", "chairman", "treasurer", "admin"]) {
      expect(canViewMembers({ role, email: "x@church.org" })).toBe(true);
    }
  });

  it("plain members and lone approvers do not (viewing is a role-manager floor)", () => {
    expect(canViewMembers({ role: "member", email: "m@church.org" })).toBe(false);
    expect(canViewMembers({ role: "approver", email: "p@church.org" })).toBe(false);
    expect(canViewMembers({ role: "", email: "x@church.org" })).toBe(false);
  });

  // A10 pauses: a role-holder who has stepped back from every granted duty
  // drops to a member's view — the whole admin/master-data cluster (Members,
  // Positions, Budget Categories) vanishes together, matching Teams/Admin.
  it("an executive officer loses the page once approvals — their only granted duty — is paused", () => {
    for (const role of ["secretary", "chairman"]) {
      expect(canViewMembers({ role, email: "o@church.org", approvalsPaused: true })).toBe(false);
    }
  });

  it("a treasurer keeps it while ANY granted duty is active, loses it when all are paused", () => {
    expect(canViewMembers({ role: "treasurer", email: "t@church.org", financePaused: true })).toBe(true);
    expect(
      canViewMembers({ role: "treasurer", email: "t@church.org", approvalsPaused: true, financePaused: true })
    ).toBe(false);
  });

  it("an admin keeps it until all three duties are paused", () => {
    expect(
      canViewMembers({ role: "admin", email: "a@church.org", approvalsPaused: true, financePaused: true })
    ).toBe(true);
    expect(
      canViewMembers({
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
    expect(canViewMembers({ role: "member", email: "BOSS@Church.ORG" })).toBe(true);
    expect(canViewMembers({ role: "member", email: "boss@church.org", adminPaused: true })).toBe(false);
    expect(canViewMembers({ role: "member", email: "notboss@church.org" })).toBe(false);
  });
});
