import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminEmails, isAppAdmin } from "@/lib/config";

// ADMIN_EMAILS seeds admins for the /admin area without a roster GRANT_ROLE.
// It resolves through configValue, so a throwaway DATA_DIR isolates each test.
describe("ADMIN_EMAILS / isAppAdmin", () => {
  const oldEnv = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "numbers-admin-"));
    process.env.DATA_DIR = dir;
    delete process.env.ADMIN_EMAILS;
  });
  afterEach(() => {
    process.env = { ...oldEnv };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is empty and role-only when unset", () => {
    expect(adminEmails()).toEqual([]);
    expect(isAppAdmin({ email: "a@x.org", role: "member" })).toBe(false);
    expect(isAppAdmin({ email: "a@x.org", role: "admin" })).toBe(true);
  });

  it("parses comma/space-separated emails, lowercased", () => {
    process.env.ADMIN_EMAILS = "  Alice@X.org,  bob@x.org  charlie@x.org ";
    expect(adminEmails()).toEqual(["alice@x.org", "bob@x.org", "charlie@x.org"]);
  });

  it("grants a listed member admin, case-insensitively", () => {
    process.env.ADMIN_EMAILS = "pastor@church.org";
    expect(isAppAdmin({ email: "Pastor@Church.org", role: "member" })).toBe(true);
    expect(isAppAdmin({ email: "someone@else.org", role: "member" })).toBe(false);
  });

  it("never depends on it for a roster admin", () => {
    expect(isAppAdmin({ email: "root@church.org", role: "admin" })).toBe(true);
  });
});
