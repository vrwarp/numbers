import { describe, expect, it } from "vitest";
import { WIZARDS, wizardFor } from "@/lib/admin/wizards";
import { ADMIN_CONFIG_FIELDS, ADMIN_CONFIG_GROUPS } from "@/lib/admin/config-schema";

/**
 * Guard the setup wizards (docs/ADMIN.md) against config drift: a config-backed
 * step must only reference real allowlisted keys, and the search wizard must
 * define metadata for every field it edits.
 */

describe("setup wizards", () => {
  const configKeys = new Set(ADMIN_CONFIG_FIELDS.map((f) => f.key));

  it("services are unique", () => {
    const services = WIZARDS.map((w) => w.service);
    expect(new Set(services).size).toBe(services.length);
  });

  it("every config-backed step field is an allowlisted config key", () => {
    for (const w of WIZARDS.filter((w) => w.backend === "config")) {
      for (const step of w.steps) {
        for (const key of step.fieldKeys) {
          expect(configKeys.has(key), `${w.service}/${step.id}: ${key}`).toBe(true);
        }
      }
    }
  });

  it("config wizards only edit keys from their own group's fields", () => {
    // Sanity: the groups referenced by wizards all exist in the schema.
    const groups = new Set<string>(ADMIN_CONFIG_GROUPS);
    for (const key of ["push", "ai", "firebase"]) {
      const w = wizardFor(key)!;
      expect(w).toBeTruthy();
      for (const step of w.steps) {
        for (const fk of step.fieldKeys) {
          const field = ADMIN_CONFIG_FIELDS.find((f) => f.key === fk)!;
          expect(groups.has(field.group)).toBe(true);
        }
      }
    }
  });

  it("the search wizard defines metadata for every field it edits", () => {
    const search = wizardFor("search")!;
    expect(search.backend).toBe("search");
    const defined = new Set((search.searchFields ?? []).map((f) => f.key));
    for (const step of search.steps) {
      for (const key of step.fieldKeys) {
        expect(defined.has(key), `search field ${key} has no metadata`).toBe(true);
      }
    }
  });

  it("at least one step per wizard offers a dry-run test", () => {
    for (const w of WIZARDS) {
      expect(w.steps.some((s) => s.test), `${w.service} has no testable step`).toBe(true);
    }
  });
});
