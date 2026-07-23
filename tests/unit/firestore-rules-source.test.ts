import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  FIRESTORE_RULES_SOURCE,
  normalizeRules,
  rulesMatch,
} from "@/lib/esign/firestore-rules-source";

// The embedded copy lets the server diff/deploy rules without shipping
// firestore.rules in the standalone image. firestore.rules stays the source of
// truth; this guard fails (showing both) if they ever diverge.
describe("FIRESTORE_RULES_SOURCE", () => {
  it("matches the committed firestore.rules (edit both together)", () => {
    const onDisk = fs.readFileSync(path.join(process.cwd(), "firestore.rules"), "utf8");
    expect(
      rulesMatch(FIRESTORE_RULES_SOURCE, onDisk),
      "src/lib/esign/firestore-rules-source.ts is out of sync with firestore.rules — copy the file's contents into the constant"
    ).toBe(true);
  });

  it("still carries the hardening fork (createdAt == request.time)", () => {
    expect(FIRESTORE_RULES_SOURCE).toContain("request.resource.data.createdAt == request.time");
    expect(FIRESTORE_RULES_SOURCE).toContain("hasOnly(['eventId', 'createdAt', 'encryptedData', 'iv'])");
  });
});

describe("normalizeRules / rulesMatch", () => {
  it("ignores trailing whitespace, CRLF, and surrounding blank lines", () => {
    const a = "service cloud.firestore {\n  match /x {}\n}\n";
    const b = "\r\n service cloud.firestore {  \r\n  match /x {}\r\n}\r\n\r\n";
    expect(rulesMatch(a, b)).toBe(true);
  });

  it("treats a genuinely different (e.g. permissive) ruleset as drift", () => {
    const hardened = FIRESTORE_RULES_SOURCE;
    const permissive = "service cloud.firestore {\n  match /{document=**} { allow read, write: if true; }\n}\n";
    expect(rulesMatch(hardened, permissive)).toBe(false);
  });

  it("keeps comments significant (does not strip them)", () => {
    expect(normalizeRules("// a\nx")).not.toBe(normalizeRules("// b\nx"));
  });
});
