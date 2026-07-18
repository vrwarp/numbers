import { describe, expect, it } from "vitest";
import {
  approverEligibility,
  pickSuggestedApprover,
  type ApproverEligibility,
  type PositionForSuggest,
} from "@/lib/positions";

describe("approverEligibility", () => {
  it("is ok only for an attested Approver+ with approvals active", () => {
    expect(approverEligibility({ role: "approver", attested: true, approvalsPaused: false })).toBe("ok");
    expect(approverEligibility({ role: "treasurer", attested: true, approvalsPaused: false })).toBe("ok");
    expect(approverEligibility({ role: "admin", attested: true, approvalsPaused: false })).toBe("ok");
  });
  it("is paused for an eligible approver who paused approvals (A10)", () => {
    expect(approverEligibility({ role: "approver", attested: true, approvalsPaused: true })).toBe("paused");
  });
  it("cannotApprove for a plain member or an un-attested key", () => {
    expect(approverEligibility({ role: "member", attested: true, approvalsPaused: false })).toBe("cannotApprove");
    expect(approverEligibility({ role: "approver", attested: false, approvalsPaused: false })).toBe("cannotApprove");
  });
  it("cannotApprove for chairman/secretary — executive officers hold no approval authority (A11)", () => {
    expect(approverEligibility({ role: "chairman", attested: true, approvalsPaused: false })).toBe("cannotApprove");
    expect(approverEligibility({ role: "secretary", attested: true, approvalsPaused: false })).toBe("cannotApprove");
  });
});

// Helper builders keep the selection cases readable.
const pos = (name: string, holderUserIds: string[], active = true): PositionForSuggest => ({
  name,
  active,
  holderUserIds,
});
const elig = (m: Record<string, ApproverEligibility>) => new Map(Object.entries(m));

describe("pickSuggestedApprover", () => {
  it("returns null when no category has a default position", () => {
    const out = pickSuggestedApprover({
      lineItems: [{ ministry: "210 Missions", amountCents: 5000 }],
      categoryDefault: new Map([["210", null]]),
      positions: new Map(),
      eligibility: new Map(),
      ownerUserId: "owner",
    });
    expect(out).toBeNull();
  });

  it("pre-fills the first eligible holder (primary) of the resolved position", () => {
    const out = pickSuggestedApprover({
      lineItems: [{ ministry: "210 Missions", amountCents: 5000 }],
      categoryDefault: new Map([["210", "pDeacon"]]),
      positions: new Map([["pDeacon", pos("Deacon of Missions", ["jane", "mike"])]]),
      eligibility: elig({ jane: "ok", mike: "ok" }),
      ownerUserId: "owner",
    });
    expect(out).toEqual({ userId: "jane", positionId: "pDeacon", positionName: "Deacon of Missions" });
  });

  it("skips ineligible/paused holders and takes the next eligible backup", () => {
    const out = pickSuggestedApprover({
      lineItems: [{ ministry: "210 Missions", amountCents: 5000 }],
      categoryDefault: new Map([["210", "pDeacon"]]),
      positions: new Map([["pDeacon", pos("Deacon", ["priya", "mike"])]]),
      eligibility: elig({ priya: "cannotApprove", mike: "ok" }),
      ownerUserId: "owner",
    });
    expect(out?.userId).toBe("mike");
  });

  it("never pre-fills the requestor as their own approver", () => {
    const out = pickSuggestedApprover({
      lineItems: [{ ministry: "210 Missions", amountCents: 5000 }],
      categoryDefault: new Map([["210", "pDeacon"]]),
      positions: new Map([["pDeacon", pos("Deacon", ["owner", "mike"])]]),
      eligibility: elig({ owner: "ok", mike: "ok" }),
      ownerUserId: "owner",
    });
    expect(out?.userId).toBe("mike");
  });

  it("guesses the largest-dollar category's position on a multi-category claim", () => {
    const out = pickSuggestedApprover({
      lineItems: [
        { ministry: "210 Missions", amountCents: 2000 }, // Deacon: $20
        { ministry: "310 Office", amountCents: 9000 }, // Staff: $90 → wins
      ],
      categoryDefault: new Map([
        ["210", "pDeacon"],
        ["310", "pStaff"],
      ]),
      positions: new Map([
        ["pDeacon", pos("Deacon", ["jane"])],
        ["pStaff", pos("Staff", ["sam"])],
      ]),
      eligibility: elig({ jane: "ok", sam: "ok" }),
      ownerUserId: "owner",
    });
    expect(out?.userId).toBe("sam");
    expect(out?.positionName).toBe("Staff");
  });

  it("falls through to the next-ranked position when the top one has no eligible holder", () => {
    const out = pickSuggestedApprover({
      lineItems: [
        { ministry: "210 Missions", amountCents: 2000 },
        { ministry: "310 Office", amountCents: 9000 }, // top dollars, but no eligible holder
      ],
      categoryDefault: new Map([
        ["210", "pDeacon"],
        ["310", "pStaff"],
      ]),
      positions: new Map([
        ["pDeacon", pos("Deacon", ["jane"])],
        ["pStaff", pos("Staff", ["priya"])],
      ]),
      eligibility: elig({ jane: "ok", priya: "cannotApprove" }),
      ownerUserId: "owner",
    });
    expect(out?.userId).toBe("jane");
  });

  it("ignores archived positions and free-text (uncoded) ministries", () => {
    const out = pickSuggestedApprover({
      lineItems: [
        { ministry: "Coffee run", amountCents: 5000 }, // no code
        { ministry: "210 Missions", amountCents: 3000 },
      ],
      categoryDefault: new Map([["210", "pDeacon"]]),
      positions: new Map([["pDeacon", pos("Deacon", ["jane"], false)]]), // archived
      eligibility: elig({ jane: "ok" }),
      ownerUserId: "owner",
    });
    expect(out).toBeNull();
  });
});
