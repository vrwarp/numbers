import { describe, expect, it } from "vitest";
import {
  sha256Hex,
  receiptPromptText,
  receiptYear,
  buildClaimComposite,
  claimFingerprint,
  claimYear,
  type ClaimContent,
} from "@/lib/embeddings/content";

/**
 * Edge-case coverage of the pure embedding-input builders that
 * embeddings.test.ts leaves uncovered: sha256Hex, the optional-field branches
 * of the prompt/composite builders, ministry/event formatting, year boundaries,
 * and the mm/yyyy source selection.
 */

describe("sha256Hex", () => {
  it("returns a 64-char lowercase hex digest", () => {
    const h = sha256Hex("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("is deterministic and collision-sensitive", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
  });

  it("hashes a Buffer identically to the equivalent string bytes", () => {
    expect(sha256Hex(Buffer.from("café", "utf8"))).toBe(sha256Hex("café"));
  });
});

describe("receiptPromptText — optional fields", () => {
  it("always leads with the fixed sentence", () => {
    expect(receiptPromptText({ merchant: "", note: "" })).toBe(
      "A photographed purchase receipt."
    );
  });

  it("appends merchant before note when both present", () => {
    expect(receiptPromptText({ merchant: "Costco", note: "tables" })).toBe(
      "A photographed purchase receipt. Merchant: Costco. User note: tables."
    );
  });

  it("omits the empty half", () => {
    expect(receiptPromptText({ merchant: "Costco", note: "" })).toBe(
      "A photographed purchase receipt. Merchant: Costco."
    );
    expect(receiptPromptText({ merchant: "", note: "tables" })).toBe(
      "A photographed purchase receipt. User note: tables."
    );
  });
});

describe("receiptYear — boundaries", () => {
  const upload = new Date("2026-03-04T00:00:00Z");
  const y = (purchaseDate: string) => receiptYear({ purchaseDate, createdAt: upload }, "UTC");

  it("reads a plausible YYYY prefix from a full date", () => {
    expect(y("2024-05-12")).toBe(2024);
    expect(y("2024-05-12T09:30:00Z")).toBe(2024);
  });

  it("accepts the inclusive plausibility bounds 1990 and 2100", () => {
    expect(y("1990-01-01")).toBe(1990);
    expect(y("2100-12-31")).toBe(2100);
  });

  it("falls back to the upload year outside the bounds", () => {
    expect(y("1989-12-31")).toBe(2026);
    expect(y("2101-01-01")).toBe(2026);
  });

  it("falls back when the string is not a full date prefix", () => {
    expect(y("")).toBe(2026);
    expect(y("2024-05")).toBe(2026); // regex needs YYYY-MM-DD
    expect(y("May 2024")).toBe(2026);
  });

  it("the fallback reads the upload instant in the app zone; a transcribed date is zone-free", () => {
    const newYearsEveUpload = new Date("2026-01-01T05:00:00Z"); // Dec 31 21:00 PST
    expect(receiptYear({ purchaseDate: "", createdAt: newYearsEveUpload }, "America/Los_Angeles")).toBe(2025);
    expect(receiptYear({ purchaseDate: "", createdAt: newYearsEveUpload }, "UTC")).toBe(2026);
    expect(
      receiptYear({ purchaseDate: "2024-05-12", createdAt: newYearsEveUpload }, "America/Los_Angeles")
    ).toBe(2024);
  });
});

function claim(over: Partial<ClaimContent> = {}): ClaimContent {
  return {
    ownerName: "Grace Lee",
    claimDescription: "",
    lineItems: [],
    merchants: [],
    totalCents: 100,
    createdAt: new Date("2026-06-22T10:00:00Z"),
    submittedAt: null,
    ...over,
  };
}

describe("buildClaimComposite — sparse / branch coverage", () => {
  it("a minimal empty-field claim omits description, ministries, merchants and items", () => {
    const text = buildClaimComposite(claim(), "UTC");
    expect(text).toBe("Reimbursement claim by Grace Lee. Total $1.00. 06/2026.");
  });

  it("includes the description clause only when present", () => {
    expect(buildClaimComposite(claim({ claimDescription: "Retreat" }), "UTC")).toContain(
      "by Grace Lee. Retreat."
    );
  });

  it("formats ministry-only and event-only rows via formatMinistryEvent", () => {
    const text = buildClaimComposite(
      claim({
        lineItems: [
          { description: "a", amountCents: 100, ministry: "210 Youth", event: "", isExcluded: false },
          { description: "b", amountCents: 100, ministry: "", event: "Retreat", isExcluded: false },
          { description: "c", amountCents: 100, ministry: "Music", event: "Concert", isExcluded: false },
        ],
      }),
      "UTC"
    );
    expect(text).toContain("Ministries: 210 Youth; Retreat; Music — Concert.");
  });

  it("drops rows with neither ministry nor event from the ministries list", () => {
    const text = buildClaimComposite(
      claim({
        lineItems: [
          { description: "a", amountCents: 100, ministry: "", event: "", isExcluded: false },
        ],
      }),
      "UTC"
    );
    expect(text).not.toContain("Ministries:");
  });

  it("de-duplicates ministries and merchants", () => {
    const text = buildClaimComposite(
      claim({
        lineItems: [
          { description: "a", amountCents: 100, ministry: "210 Youth", event: "", isExcluded: false },
          { description: "b", amountCents: 100, ministry: "210 Youth", event: "", isExcluded: false },
        ],
        merchants: ["Costco", "Costco", "Amazon"],
      }),
      "UTC"
    );
    expect(text).toContain("Ministries: 210 Youth.");
    expect(text).toContain("Merchants: Costco, Amazon.");
  });

  it("omits the Items clause when every row is excluded", () => {
    const text = buildClaimComposite(
      claim({
        lineItems: [
          { description: "snacks", amountCents: 500, ministry: "", event: "", isExcluded: true },
        ],
      }),
      "UTC"
    );
    expect(text).not.toContain("Items:");
    expect(text).not.toContain("snacks");
  });

  it("lists a few items with no omission tail when they fit the budget", () => {
    const text = buildClaimComposite(
      claim({
        lineItems: [
          { description: "tables", amountCents: 10210, ministry: "", event: "", isExcluded: false },
          { description: "plates", amountCents: 3095, ministry: "", event: "", isExcluded: false },
        ],
      }),
      "UTC"
    );
    expect(text).toContain("Items: tables ($102.10); plates ($30.95).");
    expect(text).not.toMatch(/more items/);
  });

  it("uses submittedAt for mm/yyyy when set, else createdAt, in the given zone", () => {
    expect(buildClaimComposite(claim(), "UTC")).toContain("06/2026.");
    expect(
      buildClaimComposite(claim({ submittedAt: new Date("2027-01-15T00:00:00Z") }), "UTC")
    ).toContain("01/2027.");
  });
});

describe("claimFingerprint / claimYear", () => {
  it("fingerprint equals sha256 of the composite (same zone)", () => {
    const c = claim({ claimDescription: "Retreat" });
    expect(claimFingerprint(c, "UTC")).toBe(sha256Hex(buildClaimComposite(c, "UTC")));
  });

  it("the zone is part of the fingerprint input when it shifts the month label", () => {
    const c = claim({ submittedAt: new Date("2026-07-01T02:00:00Z") }); // Jun 30 19:00 PDT
    expect(buildClaimComposite(c, "America/Los_Angeles")).toContain("06/2026.");
    expect(buildClaimComposite(c, "UTC")).toContain("07/2026.");
    expect(claimFingerprint(c, "America/Los_Angeles")).not.toBe(claimFingerprint(c, "UTC"));
  });

  it("year prefers submittedAt and reads it in the app zone", () => {
    expect(
      claimYear({ createdAt: new Date("2025-12-31T23:00:00Z"), submittedAt: null }, "UTC")
    ).toBe(2025);
    expect(
      claimYear(
        {
          createdAt: new Date("2025-12-31T23:00:00Z"),
          submittedAt: new Date("2026-01-01T00:30:00Z"),
        },
        "UTC"
      )
    ).toBe(2026);
    // The same submit instant is still 2025 in Hayward.
    expect(
      claimYear(
        {
          createdAt: new Date("2025-12-31T23:00:00Z"),
          submittedAt: new Date("2026-01-01T00:30:00Z"),
        },
        "America/Los_Angeles"
      )
    ).toBe(2025);
  });
});
