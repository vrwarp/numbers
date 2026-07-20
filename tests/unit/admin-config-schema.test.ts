import { describe, expect, it } from "vitest";
import {
  ADMIN_CONFIG_FIELDS,
  adminConfigField,
  normalizeConfigValue,
} from "@/lib/admin/config-schema";

// The allowlist is the only surface the admin editor can touch; validation
// happens before anything is written to the data volume.
describe("admin config schema", () => {
  it("never exposes bootstrap/auth-critical/test-only keys", () => {
    const keys = new Set(ADMIN_CONFIG_FIELDS.map((f) => f.key));
    for (const forbidden of [
      "DATABASE_URL",
      "DATA_DIR",
      "AUTH_SECRET",
      "AI_MOCK",
      "AUTH_TEST_MODE",
      "ESIGN_MOCK",
      "CHURCH_CONTEXT_PATH",
      "FIREBASE_AUTH_EMULATOR_HOST",
      "FIRESTORE_EMULATOR_HOST",
    ]) {
      expect(keys.has(forbidden), `${forbidden} must not be editable`).toBe(false);
    }
  });

  it("empty input clears any key", () => {
    const f = adminConfigField("OPENROUTER_MODEL")!;
    expect(normalizeConfigValue(f, "")).toBeNull();
    expect(normalizeConfigValue(f, "   ")).toBeNull();
  });

  it("validates number bounds", () => {
    const f = adminConfigField("AI_RPM_TARGET")!;
    expect(normalizeConfigValue(f, "12")).toBe("12");
    expect(() => normalizeConfigValue(f, "0")).toThrow();
    expect(() => normalizeConfigValue(f, "1.5")).toThrow();
    expect(() => normalizeConfigValue(f, "abc")).toThrow();
  });

  it("enforces select options", () => {
    const f = adminConfigField("AI_PROVIDER")!;
    expect(normalizeConfigValue(f, "google")).toBe("google");
    expect(() => normalizeConfigValue(f, "azure")).toThrow();
  });

  it("stores the onValue for a boolean regardless of casing input", () => {
    const f = adminConfigField("FIREBASE_AUTH_PROXY")!;
    expect(normalizeConfigValue(f, "1")).toBe("1");
    expect(normalizeConfigValue(f, "")).toBeNull(); // off clears
  });

  it("validates TIME_ZONE as an IANA zone name", () => {
    const f = adminConfigField("TIME_ZONE")!;
    expect(normalizeConfigValue(f, "America/New_York")).toBe("America/New_York");
    expect(normalizeConfigValue(f, "")).toBeNull(); // blank clears → default zone
    expect(() => normalizeConfigValue(f, "Hayward Standard Time")).toThrow();
  });

  it("marks the provider keys secret but not the public Firebase key", () => {
    const secrets = ADMIN_CONFIG_FIELDS.filter((f) => f.secret).map((f) => f.key);
    expect(secrets).toContain("OPENROUTER_API_KEY");
    expect(secrets).toContain("GEMINI_API_KEY");
    // A Firebase web API key is a public client identifier, not a secret.
    expect(secrets).not.toContain("FIREBASE_API_KEY");
  });

  it("unknown keys are not editable fields", () => {
    expect(adminConfigField("AUTH_SECRET")).toBeUndefined();
  });
});
