import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_QUOTA_COOLDOWN_MS,
  DEFAULT_QUOTA_MAX_RETRIES,
  DEFAULT_RPM_TARGET,
  FORM_ROWS_PER_PAGE,
  IMAGE_TARGET_BYTES,
  adminEmails,
  dataDir,
  esignEmulatorHosts,
  esignRootEmail,
  esignRootFingerprint,
  firebaseAuthDomainHost,
  isAiMock,
  isAppAdmin,
  isAuthTestMode,
  isEsignMock,
  isFirebaseAuthProxyEnabled,
  publicBaseUrl,
  quotaCooldownMs,
  quotaMaxRetries,
  rpmTarget,
  uploadsDir,
} from "@/lib/config";

// config.ts reads knobs via configValue(), which overlays a JSON file under
// DATA_DIR on top of process.env. Point DATA_DIR at a throwaway (fileless) dir
// so every configValue() falls straight through to the process.env we set here.
const TEST_KEYS = [
  "AI_RPM_TARGET",
  "AI_QUOTA_COOLDOWN_MS",
  "AI_QUOTA_MAX_RETRIES",
  "AI_MOCK",
  "AUTH_TEST_MODE",
  "PUBLIC_BASE_URL",
  "ADMIN_EMAILS",
  "ESIGN_MOCK",
  "ESIGN_ROOT_EMAIL",
  "ESIGN_ROOT_FINGERPRINT",
  "FIREBASE_AUTH_EMULATOR_HOST",
  "FIRESTORE_EMULATOR_HOST",
  "FIREBASE_AUTH_PROXY",
  "FIREBASE_AUTH_DOMAIN",
];

const oldEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "numbers-config-"));
  process.env.DATA_DIR = dir;
  for (const k of TEST_KEYS) delete process.env[k];
});
afterEach(() => {
  process.env = { ...oldEnv };
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("constants", () => {
  it("fixed CFCC-form + image knobs", () => {
    expect(FORM_ROWS_PER_PAGE).toBe(13);
    expect(IMAGE_TARGET_BYTES).toBe(100 * 1024);
    expect(DEFAULT_RPM_TARGET).toBe(15);
    expect(DEFAULT_QUOTA_COOLDOWN_MS).toBe(60_000);
    expect(DEFAULT_QUOTA_MAX_RETRIES).toBe(3);
  });
});

describe("rpmTarget (floor 1)", () => {
  const cases: [string | undefined, number][] = [
    [undefined, DEFAULT_RPM_TARGET], // missing → default
    ["", DEFAULT_RPM_TARGET], // blank → default
    ["10", 10],
    ["1", 1], // exact floor
    ["0", DEFAULT_RPM_TARGET], // below floor → default
    ["-5", DEFAULT_RPM_TARGET], // negative → default
    ["15.9", 15], // fractional → floored
    ["abc", DEFAULT_RPM_TARGET], // non-numeric → default
    ["NaN", DEFAULT_RPM_TARGET],
    ["Infinity", DEFAULT_RPM_TARGET], // not finite → default
    ["  20  ", 20], // Number() trims whitespace
  ];
  it.each(cases)("AI_RPM_TARGET=%o → %i", (val, want) => {
    if (val === undefined) delete process.env.AI_RPM_TARGET;
    else process.env.AI_RPM_TARGET = val;
    expect(rpmTarget()).toBe(want);
  });
});

describe("quotaCooldownMs (floor 0)", () => {
  const cases: [string | undefined, number][] = [
    [undefined, DEFAULT_QUOTA_COOLDOWN_MS],
    ["", DEFAULT_QUOTA_COOLDOWN_MS],
    ["0", 0], // zero is allowed (min 0)
    ["30000", 30000],
    ["-1", DEFAULT_QUOTA_COOLDOWN_MS], // below floor → default
    ["500.7", 500], // floored
    ["x", DEFAULT_QUOTA_COOLDOWN_MS],
  ];
  it.each(cases)("AI_QUOTA_COOLDOWN_MS=%o → %i", (val, want) => {
    if (val === undefined) delete process.env.AI_QUOTA_COOLDOWN_MS;
    else process.env.AI_QUOTA_COOLDOWN_MS = val;
    expect(quotaCooldownMs()).toBe(want);
  });
});

describe("quotaMaxRetries (floor 0)", () => {
  const cases: [string | undefined, number][] = [
    [undefined, DEFAULT_QUOTA_MAX_RETRIES],
    ["0", 0], // surface immediately
    ["5", 5],
    ["-2", DEFAULT_QUOTA_MAX_RETRIES],
    ["2.9", 2],
    ["nope", DEFAULT_QUOTA_MAX_RETRIES],
  ];
  it.each(cases)("AI_QUOTA_MAX_RETRIES=%o → %i", (val, want) => {
    if (val === undefined) delete process.env.AI_QUOTA_MAX_RETRIES;
    else process.env.AI_QUOTA_MAX_RETRIES = val;
    expect(quotaMaxRetries()).toBe(want);
  });
});

describe("dataDir / uploadsDir", () => {
  it("resolves an absolute DATA_DIR unchanged", () => {
    process.env.DATA_DIR = "/var/numbers-data";
    expect(dataDir()).toBe("/var/numbers-data");
    expect(uploadsDir()).toBe(path.join("/var/numbers-data", "uploads"));
  });

  it("resolves a relative DATA_DIR against cwd", () => {
    process.env.DATA_DIR = "./somewhere";
    expect(dataDir()).toBe(path.resolve("./somewhere"));
  });

  it("defaults to ./data when unset", () => {
    delete process.env.DATA_DIR;
    expect(dataDir()).toBe(path.resolve("./data"));
  });
});

describe("boolean flags (=== '1')", () => {
  it("isAiMock", () => {
    expect(isAiMock()).toBe(false);
    process.env.AI_MOCK = "1";
    expect(isAiMock()).toBe(true);
    process.env.AI_MOCK = "true"; // only literal "1" counts
    expect(isAiMock()).toBe(false);
  });

  it("isAuthTestMode / isEsignMock / isFirebaseAuthProxyEnabled", () => {
    expect(isAuthTestMode()).toBe(false);
    expect(isEsignMock()).toBe(false);
    expect(isFirebaseAuthProxyEnabled()).toBe(false);
    process.env.AUTH_TEST_MODE = "1";
    process.env.ESIGN_MOCK = "1";
    process.env.FIREBASE_AUTH_PROXY = "1";
    expect(isAuthTestMode()).toBe(true);
    expect(isEsignMock()).toBe(true);
    expect(isFirebaseAuthProxyEnabled()).toBe(true);
  });
});

describe("publicBaseUrl", () => {
  it("undefined when unset or blank", () => {
    expect(publicBaseUrl()).toBeUndefined();
    process.env.PUBLIC_BASE_URL = "   ";
    expect(publicBaseUrl()).toBeUndefined();
  });

  it("trims and drops trailing slashes", () => {
    process.env.PUBLIC_BASE_URL = "  https://numbers.example.org///  ";
    expect(publicBaseUrl()).toBe("https://numbers.example.org");
    process.env.PUBLIC_BASE_URL = "https://x.org/base/";
    expect(publicBaseUrl()).toBe("https://x.org/base");
  });
});

describe("adminEmails", () => {
  it("empty when unset", () => {
    expect(adminEmails()).toEqual([]);
  });

  it("splits on commas/whitespace, lowercases, and drops blanks", () => {
    process.env.ADMIN_EMAILS = "  A@B.com,  C@D.ORG\n e@f.io ,,";
    expect(adminEmails()).toEqual(["a@b.com", "c@d.org", "e@f.io"]);
  });

  it("single value", () => {
    process.env.ADMIN_EMAILS = "Solo@Example.com";
    expect(adminEmails()).toEqual(["solo@example.com"]);
  });
});

describe("isAppAdmin", () => {
  it("true for the roster admin role", () => {
    expect(isAppAdmin({ email: "x@y.z", role: "admin" })).toBe(true);
  });

  it("false for other roles without an ADMIN_EMAILS grant", () => {
    expect(isAppAdmin({ email: "x@y.z", role: "member" })).toBe(false);
    expect(isAppAdmin({ email: "x@y.z", role: "treasurer" })).toBe(false);
  });

  it("grants via ADMIN_EMAILS (case-insensitive)", () => {
    process.env.ADMIN_EMAILS = "boss@church.org";
    expect(isAppAdmin({ email: "BOSS@Church.ORG", role: "member" })).toBe(true);
    expect(isAppAdmin({ email: "other@church.org", role: "member" })).toBe(false);
  });

  it("a paused admin fails regardless of how adminship was granted", () => {
    expect(isAppAdmin({ email: "x@y.z", role: "admin", adminPaused: true })).toBe(false);
    process.env.ADMIN_EMAILS = "boss@church.org";
    expect(isAppAdmin({ email: "boss@church.org", role: "member", adminPaused: true })).toBe(false);
  });
});

describe("esignRootEmail", () => {
  it("undefined when unset or blank", () => {
    expect(esignRootEmail()).toBeUndefined();
    process.env.ESIGN_ROOT_EMAIL = "   ";
    expect(esignRootEmail()).toBeUndefined();
  });

  it("trims and lowercases", () => {
    process.env.ESIGN_ROOT_EMAIL = "  Root@Example.COM ";
    expect(esignRootEmail()).toBe("root@example.com");
  });
});

describe("esignRootFingerprint", () => {
  it("undefined when unset", () => {
    expect(esignRootFingerprint()).toBeUndefined();
  });

  it("normalizes grouping/case and keeps only hex", () => {
    // 32 hex nibbles across colon-grouped, upper-case input.
    process.env.ESIGN_ROOT_FINGERPRINT = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
    expect(esignRootFingerprint()).toBe("abcdef0123456789abcdef0123456789");
  });

  it("rejects a fingerprint under 16 bytes (32 hex chars)", () => {
    process.env.ESIGN_ROOT_FINGERPRINT = "abcdef0123456789abcdef012345678"; // 31 chars
    expect(esignRootFingerprint()).toBeUndefined();
  });

  it("accepts exactly 32 hex chars", () => {
    process.env.ESIGN_ROOT_FINGERPRINT = "0123456789abcdef0123456789abcdef";
    expect(esignRootFingerprint()).toBe("0123456789abcdef0123456789abcdef");
  });
});

describe("esignEmulatorHosts", () => {
  it("null unless BOTH hosts are set", () => {
    expect(esignEmulatorHosts()).toBeNull();
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
    expect(esignEmulatorHosts()).toBeNull();
    process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
    expect(esignEmulatorHosts()).toEqual({ auth: "localhost:9099", firestore: "localhost:8080" });
  });
});

describe("firebaseAuthDomainHost", () => {
  it("undefined when unset", () => {
    expect(firebaseAuthDomainHost()).toBeUndefined();
  });

  it("host-only input passes through", () => {
    process.env.FIREBASE_AUTH_DOMAIN = "proj.firebaseapp.com";
    expect(firebaseAuthDomainHost()).toBe("proj.firebaseapp.com");
  });

  it("strips a pasted scheme and path", () => {
    process.env.FIREBASE_AUTH_DOMAIN = "https://proj.firebaseapp.com/__/auth";
    expect(firebaseAuthDomainHost()).toBe("proj.firebaseapp.com");
  });

  it("keeps an explicit port", () => {
    process.env.FIREBASE_AUTH_DOMAIN = "localhost:9099";
    expect(firebaseAuthDomainHost()).toBe("localhost:9099");
  });
});
