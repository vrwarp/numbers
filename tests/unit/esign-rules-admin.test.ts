import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deployRules, rulesHealth, serviceAccountLabel } from "@/lib/esign/rules-admin";

// Covers only the fast, network-free branches (parse, mock/no-key gates). The
// Rules-API/IAM paths need a live Google project and are exercised manually.
const SAVED = ["ESIGN_MOCK", "FIREBASE_RULES_VIEWER_JSON", "FIREBASE_PROJECT_ID"] as const;
const backup: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of SAVED) {
    backup[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of SAVED) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

describe("serviceAccountLabel", () => {
  it("returns the client_email, never the key", () => {
    expect(serviceAccountLabel('{"type":"service_account","client_email":"bot@p.iam.gserviceaccount.com"}')).toBe(
      "bot@p.iam.gserviceaccount.com"
    );
  });
  it("is null for non-service-account or garbage JSON", () => {
    expect(serviceAccountLabel('{"type":"user"}')).toBeNull();
    expect(serviceAccountLabel("not json")).toBeNull();
  });
});

describe("rulesHealth gates (no network)", () => {
  it("short-circuits to 'mock' when ESIGN_MOCK is on", async () => {
    process.env.ESIGN_MOCK = "1";
    expect((await rulesHealth()).status).toBe("mock");
  });
  it("reports 'no-key' when no viewer key is saved", async () => {
    expect((await rulesHealth()).status).toBe("no-key");
  });
  it("reports 'key-invalid' for a saved non-JSON key", async () => {
    process.env.FIREBASE_RULES_VIEWER_JSON = "definitely not json";
    expect((await rulesHealth()).status).toBe("key-invalid");
  });
});

describe("deployRules validation (no network)", () => {
  it("rejects a non-service-account key before any deploy", async () => {
    const r = await deployRules("not json");
    expect(r).toEqual({ ok: false, code: "rules.keyInvalid" });
  });
  it("requires a project id", async () => {
    const r = await deployRules('{"type":"service_account","client_email":"x@y.iam.gserviceaccount.com"}');
    expect(r).toEqual({ ok: false, code: "rules.noProject" });
  });
});
