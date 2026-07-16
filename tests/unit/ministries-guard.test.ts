import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canManageMinistries } from "@/lib/ministries-guard";

// canManageMinistries → isAppAdmin, which reads ADMIN_EMAILS via configValue()
// (DATA_DIR config file overlaid on process.env). Isolate to a fileless DATA_DIR
// so the ADMIN_EMAILS we set here is the only grant in play.
const oldEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "numbers-mg-"));
  process.env.DATA_DIR = dir;
  delete process.env.ADMIN_EMAILS;
});
afterEach(() => {
  process.env = { ...oldEnv };
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("canManageMinistries", () => {
  it("treasurers always qualify", () => {
    expect(canManageMinistries({ role: "treasurer", email: "t@church.org" })).toBe(true);
  });

  it("roster admins qualify", () => {
    expect(canManageMinistries({ role: "admin", email: "a@church.org" })).toBe(true);
  });

  it("plain members and approvers do not", () => {
    expect(canManageMinistries({ role: "member", email: "m@church.org" })).toBe(false);
    expect(canManageMinistries({ role: "approver", email: "p@church.org" })).toBe(false);
    expect(canManageMinistries({ role: "", email: "x@church.org" })).toBe(false);
  });

  it("an ADMIN_EMAILS address qualifies even as a member (case-insensitive)", () => {
    process.env.ADMIN_EMAILS = "boss@church.org";
    expect(canManageMinistries({ role: "member", email: "BOSS@Church.ORG" })).toBe(true);
    expect(canManageMinistries({ role: "member", email: "notboss@church.org" })).toBe(false);
  });
});
